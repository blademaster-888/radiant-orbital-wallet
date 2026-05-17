import { useEffect, useRef, useState } from 'react';
import { useSignals } from '@preact/signals-react/runtime';
import { BackButton } from '../../components/BackButton';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { PageLoader } from '../../components/PageLoader';
import { ConfirmContent, FormContainer, HeaderText, Text } from '../../components/Reusable';
import { Show } from '../../components/Show';
import { useRadiantTokens } from '../../hooks/useRadiantTokens';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useTheme } from '../../hooks/useTheme';
import { useWeb3Context } from '../../hooks/useWeb3Context';
import { sleep } from '../../utils/sleep';
import { storage } from '../../utils/storage';
import { locked, rxdAddress } from '../../signals';
import electrum from '../../Electrum';

const ELECTRUM_ENDPOINT = 'wss://electrumx.radiant4people.com:50022';

export type CreateSwapOfferRequestParams = {
  offerTokenRef: string;
  offerTokenTicker?: string;
  offerTokenName?: string;
  offerAmount: number;
  wantTokenRef: string;
  wantTokenTicker?: string;
  wantTokenName?: string;
  wantAmount: number;
  domain?: string;
};

export type CreateSwapOfferRequestProps = {
  request: CreateSwapOfferRequestParams;
  popupId: number | undefined;
  onResponse: () => void;
};

export const CreateSwapOfferRequest = ({ request, popupId, onResponse }: CreateSwapOfferRequestProps) => {
  useSignals();
  const { theme } = useTheme();
  const { addSnackbar } = useSnackbar();
  const { isPasswordRequired } = useWeb3Context();
  const { syncTokens, createSwapOffer, isProcessing, setIsProcessing } = useRadiantTokens();
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [syncState, setSyncState] = useState<'idle' | 'syncing' | 'ready'>('idle');
  const [syncError, setSyncError] = useState('');
  const responseSent = useRef(false);

  // Ensure electrum is connected and both tokens are synced before showing the form.
  useEffect(() => {
    if (syncState !== 'idle') return;
    const run = async () => {
      setSyncState('syncing');
      if (!electrum.connected()) {
        electrum.changeEndpoint(ELECTRUM_ENDPOINT);
        for (let i = 0; i < 20 && !electrum.connected(); i++) await sleep(150);
      }
      await syncTokens().catch((e: unknown) => {
        setSyncError((e as Error)?.message ?? String(e));
      });
      setSyncState('ready');
    };

    if (rxdAddress.value) { run(); return; }
    const unsub = rxdAddress.subscribe(addr => { if (addr) { unsub(); run(); } });
    return () => unsub();
  }, [syncState]);

  const cancel = () => {
    responseSent.current = true;
    chrome.runtime.sendMessage({ action: 'createSwapOfferResponse', cancelled: true });
    storage.remove('createSwapOfferRequest');
    if (popupId) chrome.windows.remove(popupId);
    else window.close();
  };

  const handleConfirm = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (!passwordConfirm && isPasswordRequired && locked.value) {
      addSnackbar('Password required!', 'error');
      return;
    }

    setIsProcessing(true);
    await sleep(25);

    const result = await createSwapOffer({
      offerTokenRef:    request.offerTokenRef,
      offerTokenTicker: request.offerTokenTicker,
      offerAmount:      BigInt(request.offerAmount),
      wantTokenRef:     request.wantTokenRef,
      wantTokenTicker:  request.wantTokenTicker,
      wantAmount:       BigInt(request.wantAmount),
      password:         passwordConfirm,
    });

    setIsProcessing(false);

    if ('error' in result) {
      const msg =
        result.error === 'invalid-password'       ? 'Invalid password!'           :
        result.error === 'insufficient-funds'      ? 'Insufficient token balance!' :
        result.error === 'offer-token-not-found'   ? `${request.offerTokenTicker ?? 'Offer token'} not found in wallet.` :
        result.error === 'want-token-not-found'    ? `${request.wantTokenTicker ?? 'Want token'} not found in wallet. Open Token Wallet to sync it first.` :
        result.error === 'pre-split-failed'        ? 'Failed to prepare tokens. Try again.' :
        `Error: ${result.error}`;
      chrome.runtime.sendMessage({ action: 'createSwapOfferResponse', error: result.error });
      addSnackbar(msg, 'error');
      return;
    }

    responseSent.current = true;
    addSnackbar('Offer signed!', 'success');
    chrome.runtime.sendMessage({ action: 'createSwapOfferResponse', partialRawtx: result.partialRawtx });

    setTimeout(() => {
      onResponse();
      storage.remove('createSwapOfferRequest');
      if (popupId) chrome.windows.remove(popupId);
      else window.close();
    }, 1500);
  };

  if (syncState !== 'ready') {
    return <PageLoader theme={theme} message="Syncing wallet…" />;
  }

  return (
    <>
      <Show when={isProcessing}>
        <PageLoader theme={theme} message="Creating offer… (splitting tokens)" />
      </Show>
      <Show when={!isProcessing}>
        <ConfirmContent>
          <BackButton onClick={cancel} />
          <HeaderText theme={theme}>Create Trade Offer</HeaderText>

          <div style={{ width: '85%', background: theme.mainBackground, borderRadius: 8, padding: '12px 14px', margin: '8px 0 4px' }}>
            <Text theme={theme} style={{ margin: '4px 0', fontSize: '0.85rem' }}>
              You offer: <strong>{Number(request.offerAmount).toLocaleString()} {request.offerTokenTicker ?? '?'}</strong>
            </Text>
            <Text theme={theme} style={{ margin: '4px 0', fontSize: '0.85rem' }}>
              You want: <strong>{Number(request.wantAmount).toLocaleString()} {request.wantTokenTicker ?? '?'}</strong>
            </Text>
          </div>

          <Text theme={theme} style={{ fontSize: '0.7rem', color: theme.gray, margin: '6px 0 10px', textAlign: 'center', lineHeight: 1.5 }}>
            Your tokens will be locked until a buyer completes the trade atomically.
          </Text>

          {syncError && (
            <Text theme={theme} style={{ fontSize: '0.7rem', color: '#f66', margin: '0 0 8px', wordBreak: 'break-all' }}>
              Sync warning: {syncError}
            </Text>
          )}

          {request.domain && (
            <Text theme={theme} style={{ fontSize: '0.75rem', color: theme.gray, margin: '0 0 8px' }}>
              Requested by: {request.domain}
            </Text>
          )}

          <FormContainer noValidate onSubmit={handleConfirm}>
            <Show when={isPasswordRequired && locked.value}>
              <Input
                theme={theme}
                placeholder="Enter Wallet Password"
                type="password"
                value={passwordConfirm}
                onChange={e => setPasswordConfirm(e.target.value)}
              />
            </Show>
            <Button theme={theme} type="primary" label="Sign & Create Offer" isSubmit disabled={isProcessing} />
            <Button theme={theme} type="secondary" label="Cancel" disabled={isProcessing} onClick={cancel} />
          </FormContainer>
        </ConfirmContent>
      </Show>
    </>
  );
};
