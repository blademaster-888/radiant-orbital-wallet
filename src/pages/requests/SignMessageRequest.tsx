import React, { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { styled } from 'styled-components';
import { BackButton } from '../../components/BackButton';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { PageLoader } from '../../components/PageLoader';
import { ConfirmContent, FormContainer, HeaderText, Text } from '../../components/Reusable';
import { Show } from '../../components/Show';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { useRxd, Web3SignMessageRequest } from '../../hooks/useRxd';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useTheme } from '../../hooks/useTheme';
import { useWeb3Context } from '../../hooks/useWeb3Context';
import { ColorThemeProps } from '../../theme';
import { DerivationTag } from '../../utils/keys';
import { locked } from '../../signals';
import { sleep } from '../../utils/sleep';
import { storage } from '../../utils/storage';

const RequestDetailsContainer = styled.div<ColorThemeProps>`
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  max-height: 10rem;
  overflow-y: auto;
  overflow-x: hidden;
  background: ${({ theme }) => theme.darkAccent + '80'};
  margin: 0.5rem;
`;

const TagText = styled(Text)`
  margin: 0.25rem;
`;

export type SignMessageResponse = {
  address?: string;
  pubKey?: string;
  message?: string;
  sig?: string;
  derivationTag?: DerivationTag;
  error?: string;
};

export type SignMessageRequestProps = {
  messageToSign: Web3SignMessageRequest;
  popupId: number | undefined;
  onSignature: () => void;
};

export const SignMessageRequest = (props: SignMessageRequestProps) => {
  const { messageToSign, onSignature, popupId } = props;
  const { theme } = useTheme();
  const { setSelected } = useBottomMenu();
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const { addSnackbar } = useSnackbar();
  const { isPasswordRequired } = useWeb3Context();

  const { isProcessing, setIsProcessing, signMessage } = useRxd();

  useEffect(() => {
    setSelected('rxd');
  }, [setSelected]);

  useEffect(() => {
    const onbeforeunloadFn = () => {
      if (popupId) chrome.windows.remove(popupId);
    };

    window.addEventListener('beforeunload', onbeforeunloadFn);
    return () => {
      window.removeEventListener('beforeunload', onbeforeunloadFn);
    };
  }, [popupId]);

  const handleSigning = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    flushSync(() => setIsProcessing(true));

    if (!passwordConfirm && isPasswordRequired && locked.value) {
      addSnackbar('You must enter a password!', 'error');
      setIsProcessing(false);
      return;
    }

    const signRes = await signMessage(messageToSign, passwordConfirm);
    if (!signRes?.sig) {
      const message =
        signRes?.error === 'invalid-password'
          ? 'Invalid Password!'
          : signRes?.error === 'key-type'
            ? 'Key type does not exist!'
            : 'An unknown error has occurred! Try again.';

      addSnackbar(message, 'error');
      setIsProcessing(false);
      return;
    }

    chrome.runtime.sendMessage({
      action: 'signMessageResponse',
      ...signRes,
    });

    onSignature();
    storage.remove('signMessageRequest');
    if (popupId) chrome.windows.remove(popupId);
    window.close();
  };

  const clearRequest = () => {
    chrome.runtime.sendMessage({ action: 'signMessageResponse', error: 'user-cancelled' });
    storage.remove('signMessageRequest');
    if (popupId) chrome.windows.remove(popupId);
    window.location.reload();
  };

  return (
    <>
      <Show when={isProcessing}>
        <PageLoader theme={theme} message="Signing Transaction..." />
      </Show>
      <Show when={!isProcessing && !!messageToSign}>
        <ConfirmContent>
          <BackButton onClick={clearRequest} />
          <HeaderText theme={theme}>Sign Message</HeaderText>
          <Text theme={theme} style={{ margin: '0.75rem 0' }}>
            {'The app is requesting a signature using derivation tag:'}
          </Text>
          <Show
            when={!!messageToSign.tag?.label}
            whenFalseContent={
              <>
                <TagText theme={theme}>{`Label: orbital`}</TagText>
                <TagText theme={theme}>{`Id: rxd`}</TagText>
              </>
            }
          >
            <TagText theme={theme}>{`Label: ${messageToSign.tag?.label}`}</TagText>
            <TagText theme={theme}>{`Id: ${messageToSign.tag?.id}`}</TagText>
          </Show>
          <FormContainer noValidate onSubmit={(e) => handleSigning(e)}>
            <RequestDetailsContainer>
              {<Text style={{ color: theme.white }}>{`Message: ${messageToSign.message}`}</Text>}
            </RequestDetailsContainer>
            <Show when={isPasswordRequired && locked.value}>
              <Input
                theme={theme}
                placeholder="Enter Wallet Password"
                type="password"
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
              />
            </Show>
            <Button theme={theme} type="primary" label="Sign Message" disabled={isProcessing} isSubmit />
            <Button theme={theme} type="secondary-outline" label="Cancel" disabled={isProcessing} onClick={clearRequest} />
          </FormContainer>
        </ConfirmContent>
      </Show>
    </>
  );
};
