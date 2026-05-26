import { P2PKHAddress, Transaction } from 'rxd-wasm';
import React, { useEffect, useState } from 'react';
import { BackButton } from '../../components/BackButton';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { PageLoader } from '../../components/PageLoader';
import { ConfirmContent, FormContainer, HeaderText, Text } from '../../components/Reusable';
import { Show } from '../../components/Show';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { useRxd, Web3BroadcastRequest } from '../../hooks/useRxd';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useTheme } from '../../hooks/useTheme';
import { RXD_DECIMAL_CONVERSION } from '../../utils/constants';
import { sleep } from '../../utils/sleep';
import { storage } from '../../utils/storage';
import { rxdAddress } from '../../signals';

export type BroadcastResponse = {
  txid: string;
};

export type BroadcastRequestProps = {
  request: Web3BroadcastRequest;
  popupId: number | undefined;
  onBroadcast: () => void;
};

export const BroadcastRequest = (props: BroadcastRequestProps) => {
  const { request, onBroadcast, popupId } = props;
  const { theme } = useTheme();
  const { setSelected } = useBottomMenu();
  const [txid, setTxid] = useState('');
  const { addSnackbar, message } = useSnackbar();
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [satsOut, setSatsOut] = useState(0);
  const { isProcessing, setIsProcessing, updateRxdBalance, fundRawTx, broadcastRawTx } = useRxd();

  useEffect(() => {
    setSelected('rxd');
  }, [setSelected]);

  useEffect(() => {
    if (!txid) return;
    if (!message && txid) {
      resetSendState();
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message, txid]);

  useEffect(() => {
    const onbeforeunloadFn = () => {
      if (popupId) chrome.windows.remove(popupId);
    };

    window.addEventListener('beforeunload', onbeforeunloadFn);
    return () => {
      window.removeEventListener('beforeunload', onbeforeunloadFn);
    };
  }, [popupId]);

  useEffect(() => {
    if (!rxdAddress.value) return;
    (async () => {
      const tx = Transaction.from_hex(request.rawtx);
      let satsOut = 0;
      const changeScript = P2PKHAddress.from_string(rxdAddress.value).get_locking_script().to_hex();
      for (let index = 0; index < tx.get_noutputs(); index++) {
        if (tx.get_output(index)?.get_script_pub_key_hex() !== changeScript) {
          satsOut += Number(tx.get_output(index)!.get_satoshis());
        }
      }
      setSatsOut(satsOut);
    })();
  }, [request.fund, request.rawtx]);

  const resetSendState = () => {
    setTxid('');
    setIsProcessing(false);
  };

  const handleBroadcast = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsProcessing(true);
    await sleep(25);

    let rawtx = request.rawtx;
    if (request.fund) {
      if (!passwordConfirm) {
        addSnackbar('Must enter a password!', 'error');
        setIsProcessing(false);
        return;
      }

      const res = await fundRawTx(rawtx, passwordConfirm);
      if (!res.rawtx || res.error) {
        const message =
          res.error === 'invalid-password'
            ? 'Invalid Password!'
            : 'An unknown error has occurred! Try again.' + res.error;

        addSnackbar(message, 'error');
        setIsProcessing(false);
        return;
      }
      rawtx = res.rawtx;
    }
    const txid = await broadcastRawTx(rawtx);
    if (!txid) {
      addSnackbar('Error broadcasting the raw tx!', 'error');
      setIsProcessing(false);

      chrome.runtime.sendMessage({
        action: 'broadcastResponse',
        error: 'Broadcast failed',
      });

      setTimeout(() => {
        onBroadcast();
        if (popupId) chrome.windows.remove(popupId);
      }, 2000);
      return;
    }
    setTxid(txid);
    chrome.runtime.sendMessage({
      action: 'broadcastResponse',
      txid,
    });

    setIsProcessing(false);
    addSnackbar('Successfully broadcasted the tx!', 'success');

    storage.remove('broadcastRequest');
    setTimeout(async () => {
      await updateRxdBalance(true).catch(() => {});
      onBroadcast();
      if (popupId) chrome.windows.remove(popupId);
    }, 2000);
  };

  const clearRequest = () => {
    storage.remove('broadcastRequest');
    if (popupId) chrome.windows.remove(popupId);
    window.location.reload();
  };

  return (
    <>
      <Show when={isProcessing}>
        <PageLoader theme={theme} message="Broadcasting transaction..." />
      </Show>
      <Show when={!isProcessing && !!request}>
        <ConfirmContent>
          <BackButton onClick={clearRequest} />
          <HeaderText theme={theme}>Broadcast Raw Tx</HeaderText>
          <Text theme={theme} style={{ margin: '0.75rem 0' }}>
            The app is requesting to broadcast a transaction.
          </Text>
          <FormContainer noValidate onSubmit={(e) => handleBroadcast(e)}>
            <Show when={!!request.fund && satsOut > 0}>
              <Input
                theme={theme}
                placeholder="Enter Wallet Password"
                type="password"
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
              />
            </Show>
            <Text theme={theme} style={{ margin: '1rem' }}>
              Double check details before sending.
            </Text>
            <Button
              theme={theme}
              type="primary"
              label={`Broadcast - ${satsOut / RXD_DECIMAL_CONVERSION} RXD`}
              disabled={isProcessing}
              isSubmit
            />
          </FormContainer>
        </ConfirmContent>
      </Show>
    </>
  );
};
