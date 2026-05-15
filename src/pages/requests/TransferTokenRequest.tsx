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
import { useRadiantTokens } from '../../hooks/useRadiantTokens';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useTheme } from '../../hooks/useTheme';
import { useWeb3Context } from '../../hooks/useWeb3Context';
import { truncate } from '../../utils/format';
import { sleep } from '../../utils/sleep';
import { storage } from '../../utils/storage';
import { locked } from '../../signals';

export type TransferTokenRequestParams = {
  tokenRef: string;
  address: string;
  amount: number;
  domain?: string;
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
  const { sendFt, isProcessing, setIsProcessing } = useRadiantTokens();
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const responseSent = useRef(false);

  const dexieRef = tokenRefToDexieRef(request.tokenRef);
  const token = useLiveQuery(() => db.token.get({ ref: dexieRef }), [dexieRef]);

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

  if (token === undefined) return null; // still loading

  if (!token) {
    return (
      <ConfirmContent>
        <BackButton onClick={clearRequest} />
        <HeaderText theme={theme}>Token not found</HeaderText>
        <Text theme={theme}>This token is not in your wallet.</Text>
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
