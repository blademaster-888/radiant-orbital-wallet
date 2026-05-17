import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useSignals } from '@preact/signals-react/runtime';
import { BackButton } from '../../components/BackButton';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { PageLoader } from '../../components/PageLoader';
import { ConfirmContent, FormContainer, HeaderText, Text } from '../../components/Reusable';
import { Show } from '../../components/Show';
import { db } from '../../db';
import electrum from '../../Electrum';
import { useRadiantTokens } from '../../hooks/useRadiantTokens';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useTheme } from '../../hooks/useTheme';
import { useWeb3Context } from '../../hooks/useWeb3Context';
import { truncate } from '../../utils/format';
import { sleep } from '../../utils/sleep';
import { storage } from '../../utils/storage';
import { locked, rxdAddress } from '../../signals';

const ELECTRUM_ENDPOINT = 'wss://electrumx.radiant4people.com:50022';

export type TransferTokenRequestParams = {
  tokenRef: string;
  address: string;
  amount: number;
  domain?: string;
  tokenTicker?: string;
  tokenName?: string;
};

// Convert "txid:vout" (big-endian colon) → Dexie ref (LE reversed outpoint)
function tokenRefToDexieRef(tokenRef: string): string {
  try {
    const colon = tokenRef.indexOf(':');
    if (colon === -1) return tokenRef;
    const txid = tokenRef.slice(0, colon);
    const vout = parseInt(tokenRef.slice(colon + 1), 10);
    const txidLE = Buffer.from(txid, 'hex').reverse().toString('hex');
    const voutBuf = Buffer.alloc(4);
    voutBuf.writeUInt32LE(vout);
    return `${txidLE}${voutBuf.toString('hex')}`;
  } catch {
    return tokenRef;
  }
}

export type TransferTokenRequestProps = {
  request: TransferTokenRequestParams;
  popupId: number | undefined;
  onResponse: () => void;
};

export const TransferTokenRequest = ({ request, popupId, onResponse }: TransferTokenRequestProps) => {
  useSignals();
  const { theme } = useTheme();
  const { addSnackbar } = useSnackbar();
  const { isPasswordRequired } = useWeb3Context();
  const { syncTokens, sendFt, isProcessing, setIsProcessing } = useRadiantTokens();
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const responseSent = useRef(false);
  const [syncState, setSyncState] = useState<'idle' | 'syncing' | 'done'>('idle');
  const [syncError, setSyncError] = useState('');
  const [dbTokens, setDbTokens] = useState<string[]>([]);

  const dexieRef = tokenRefToDexieRef(request.tokenRef);
  const tokenQuery = useLiveQuery(
    () => db.token.get({ ref: dexieRef }).then(async t => {
      if (t) return { token: t };
      // The glyph-miner indexer and the wallet's electrum use different outpoints
      // for the same token (dMint contract ref vs genesis UTXO ref). Fall back to
      // matching by ticker so the correct wallet token is used for sendFt.
      const ticker = request.tokenTicker;
      if (!ticker) return { token: undefined };
      const all = await db.token.toArray();
      const byTicker = all.find(u => u.ticker.toUpperCase() === ticker.toUpperCase());
      return { token: byTicker };
    }),
    [dexieRef, request.tokenTicker],
  );

  // If the token isn't in the DB yet, sync once then let useLiveQuery re-run.
  // Wait for rxdAddress to be populated (it's async from storage) before syncing,
  // otherwise syncTokens scans the wrong/empty address and finds nothing.
  useEffect(() => {
    if (syncState !== 'idle') return;
    if (tokenQuery === undefined) return;      // useLiveQuery still initialising
    if (tokenQuery.token) return;              // already found — nothing to do

    const runSync = async () => {
      setSyncState('syncing');
      // React runs child effects before parent effects, so App.tsx's
      // electrum.changeEndpoint may not have fired yet. Ensure we have an
      // endpoint and wait up to 3 s for the WebSocket handshake to finish.
      if (!electrum.connected()) {
        electrum.changeEndpoint(ELECTRUM_ENDPOINT);
        for (let i = 0; i < 20 && !electrum.connected(); i++) {
          await sleep(150);
        }
      }
      await syncTokens().catch((e: unknown) => {
        const msg = (e as Error)?.message ?? String(e);
        console.error('[TransferToken] syncTokens failed:', msg, { address: rxdAddress.value, dexieRef });
        setSyncError(msg);
      });
      const allTokens = await db.token.toArray();
      console.log('[TransferToken] DB tokens after sync:', allTokens.map(t => `${t.ticker}:${t.ref}`));
      setDbTokens(allTokens.map(t => `${t.ticker} ${t.ref.slice(0, 12)}…`));
      setSyncState('done');
    };

    if (rxdAddress.value) {
      runSync();
      return;
    }
    const unsub = rxdAddress.subscribe(addr => {
      if (addr) { unsub(); runSync(); }
    });
    return () => unsub();
  }, [tokenQuery, syncState, dexieRef, request.tokenTicker, request.tokenName]);

  // Open a long-lived port to the background. When this port disconnects for
  // any reason (Cancel button, clicking away, or closing the popup), the
  // background's onDisconnect handler fires and sends the cancel response —
  // unlike beforeunload, this is guaranteed to complete even for action popups.
  useEffect(() => {
    const port = chrome.runtime.connect({ name: 'transferTokenPopup' });
    return () => { port.disconnect(); };
  }, []);

  const clearRequest = () => {
    responseSent.current = true;
    chrome.runtime.sendMessage({ action: 'transferTokenResponse', cancelled: true });
    storage.remove('transferTokenRequest');
    if (popupId) chrome.windows.remove(popupId);
    else window.close();
  };

  const handleSend = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!token) return;

    setIsProcessing(true);
    await sleep(25);

    if (!passwordConfirm && isPasswordRequired && locked.value) {
      addSnackbar('Password required!', 'error');
      setIsProcessing(false);
      return;
    }

    const res = await sendFt(token, request.address, BigInt(request.amount), passwordConfirm);
    setIsProcessing(false);

    if (!res.txid || res.error) {
      addSnackbar(
        res.error === 'invalid-password' ? 'Invalid password!' :
        res.error === 'insufficient-funds' ? 'Insufficient funds!' :
        'Transfer failed. Try again.',
        'error',
      );
      return;
    }

    responseSent.current = true;
    addSnackbar('Tokens sent!', 'success');
    chrome.storage.local.set({ transferTokenSuccess: res.txid });
    chrome.runtime.sendMessage({ action: 'transferTokenResponse', txid: res.txid });

    setTimeout(() => {
      onResponse();
      storage.remove('transferTokenRequest');
      if (popupId) chrome.windows.remove(popupId);
      else window.close();
    }, 2000);
  };

  if (!tokenQuery || syncState === 'syncing') return <PageLoader theme={theme} message={syncState === 'syncing' ? "Syncing wallet…" : "Loading…"} />;
  const token = tokenQuery.token;

  if (!token) {
    return (
      <ConfirmContent>
        <BackButton onClick={clearRequest} />
        <HeaderText theme={theme}>Token not found</HeaderText>
        <Text theme={theme}>
          {request.tokenTicker ? `${request.tokenTicker} ` : ''}not found in your wallet.
        </Text>
        {syncError && (
          <Text theme={theme} style={{ fontSize: '0.7rem', color: '#f66', wordBreak: 'break-all', margin: '0.25rem 0' }}>
            {syncError}
          </Text>
        )}
        <Text theme={theme} style={{ fontSize: '0.65rem', color: theme.gray, wordBreak: 'break-all', margin: '0.25rem 0' }}>
          looking for: {dexieRef}
        </Text>
        {dbTokens.length > 0 && (
          <Text theme={theme} style={{ fontSize: '0.65rem', color: theme.gray, margin: '0.25rem 0' }}>
            DB has: {dbTokens.join(', ')}
          </Text>
        )}
        {dbTokens.length === 0 && syncState === 'done' && (
          <Text theme={theme} style={{ fontSize: '0.65rem', color: '#f66', margin: '0.25rem 0' }}>
            DB is empty — electrum may not have connected
          </Text>
        )}
        <Button theme={theme} type="primary" label="Retry Sync" onClick={() => setSyncState('idle')} />
        <Button theme={theme} type="secondary" label="Cancel" onClick={clearRequest} />
      </ConfirmContent>
    );
  }

  return (
    <>
      <Show when={isProcessing}>
        <PageLoader theme={theme} message={`Sending ${token.ticker}…`} />
      </Show>
      <Show when={!isProcessing}>
        <ConfirmContent>
          <BackButton onClick={clearRequest} />
          <HeaderText theme={theme}>Send {token.ticker}</HeaderText>
          <Text theme={theme} style={{ margin: '0.25rem 0' }}>
            Amount: <strong>{Number(request.amount).toLocaleString()}</strong>
          </Text>
          <Text theme={theme} style={{ margin: '0.25rem 0 0.75rem' }}>
            To: {truncate(request.address, 8, 6)}
          </Text>
          {request.domain && (
            <Text theme={theme} style={{ fontSize: '0.75rem', color: theme.gray, margin: '0 0 0.75rem' }}>
              Requested by: {request.domain}
            </Text>
          )}
          <FormContainer noValidate onSubmit={handleSend}>
            <Show when={isPasswordRequired && locked.value}>
              <Input
                theme={theme}
                placeholder="Enter Wallet Password"
                type="password"
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
              />
            </Show>
            <Text theme={theme} style={{ margin: '0.5rem', fontSize: '0.8rem' }}>
              Double-check before sending.
            </Text>
            <Button
              theme={theme}
              type="primary"
              label={`Send ${Number(request.amount).toLocaleString()} ${token.ticker}`}
              disabled={isProcessing}
              isSubmit
            />
            <Button
              theme={theme}
              type="secondary"
              label="Cancel"
              disabled={isProcessing}
              onClick={clearRequest}
            />
          </FormContainer>
        </ConfirmContent>
      </Show>
    </>
  );
};
