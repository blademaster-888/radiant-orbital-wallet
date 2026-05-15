import { useContext, useEffect, useState } from 'react';
import { styled } from 'styled-components';
import { ThirdPartyAppRequestData, WhitelistedApp } from '../../App';
import { Button } from '../../components/Button';
import { HeaderText, Text } from '../../components/Reusable';
import { Show } from '../../components/Show';
import { BottomMenuContext } from '../../contexts/BottomMenuContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useTheme } from '../../hooks/useTheme';
import { storage } from '../../utils/storage';
import greenCheck from '../../assets/green-check.svg';
import { ColorThemeProps } from '../../theme';
import { identityPubKey, rxdPubKey } from '../../signals';

const Container = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
`;

const Icon = styled.img<{ size: string }>`
  width: ${(props) => props.size};
  height: ${(props) => props.size};
  margin: 0 0 1rem 0;
  border-radius: 0.5rem;
`;

const PermissionsContainer = styled.div<ColorThemeProps>`
  display: flex;
  flex-direction: column;
  padding: 1rem;
  width: 75%;
  background-color: ${({ theme }) => theme.darkAccent};
  border-radius: 0.75rem;
  margin: 1rem 0 1.5rem 0;
`;

const Permission = styled.div`
  display: flex;
  align-items: center;
  margin: 0.5rem;
`;

const CheckMark = styled.img`
  width: 1rem;
  height: 1rem;
`;

export type ConnectRequestProps = {
  thirdPartyAppRequestData: ThirdPartyAppRequestData | undefined;
  whiteListedApps: WhitelistedApp[];
  popupId: number | undefined;
  onDecision: () => void;
};
export const ConnectRequest = (props: ConnectRequestProps) => {
  const { thirdPartyAppRequestData, whiteListedApps, popupId, onDecision } = props;
  const { theme } = useTheme();
  const context = useContext(BottomMenuContext);
  const { addSnackbar } = useSnackbar();
  const [isDecided, setIsDecided] = useState(false);

  useEffect(() => {
    if (!context) return;
    context.hideMenu();

    return () => context.showMenu();
  }, [context]);

  useEffect(() => {
    if (isDecided) return;
    if (!thirdPartyAppRequestData?.isAuthorized) return;
    if (!rxdPubKey.value) return;
    // Wallet is unlocked and site is already authorised — auto-approve silently.
    chrome.runtime.sendMessage({
      action: 'userConnectResponse',
      decision: 'approved',
      pubKeys: { rxdPubKey: rxdPubKey.value, identityPubKey: identityPubKey.value },
    });
    storage.remove('connectRequest');
    setTimeout(() => {
      if (popupId) chrome.windows.remove(popupId);
      window.close();
    }, 300);
  }, [popupId, thirdPartyAppRequestData, isDecided]);

  useEffect(() => {
    const onbeforeunloadFn = () => {
      if (popupId) chrome.windows.remove(popupId);
    };

    window.addEventListener('beforeunload', onbeforeunloadFn);
    return () => {
      window.removeEventListener('beforeunload', onbeforeunloadFn);
    };
  }, [popupId]);

  const handleConnectDecision = async (approved: boolean) => {
    if (chrome.runtime) {
      if (approved) {
        // Read connectRequest and whitelist directly from storage — the prop may not
        // have loaded yet if App.tsx's useEffect lost the race with Start.tsx's navigation.
        const stored = await chrome.storage.local.get(['connectRequest', 'whitelist']);
        const domain = stored.connectRequest?.domain ?? thirdPartyAppRequestData?.domain;
        const icon = stored.connectRequest?.appIcon ?? thirdPartyAppRequestData?.appIcon;
        const existingWhitelist: { domain: string; icon: string }[] = stored.whitelist ?? [];

        // Await the whitelist write so verifyAccess() sees it before connect() resolves
        await chrome.storage.local.set({
          whitelist: [...existingWhitelist, { domain, icon }],
        });
        chrome.runtime.sendMessage({
          action: 'userConnectResponse',
          decision: 'approved',
          pubKeys: { rxdPubKey: rxdPubKey.value, identityPubKey: identityPubKey.value },
        });
        addSnackbar(`Approved`, 'success');
      } else {
        chrome.runtime.sendMessage({
          action: 'userConnectResponse',
          decision: 'declined',
        });

        addSnackbar(`Declined`, 'error');
      }
    }

    setIsDecided(true);

    storage.remove('connectRequest');
    setTimeout(() => window.close(), 100);
  };

  return (
    <Show
      when={!thirdPartyAppRequestData?.isAuthorized}
      whenFalseContent={
        <Container>
          <Text theme={theme} style={{ fontSize: '1rem', fontWeight: 500, opacity: 0.7 }}>
            Reconnecting...
          </Text>
        </Container>
      }
    >
      <Container>
        <Icon
          size="5rem"
          src={thirdPartyAppRequestData?.appIcon || chrome.runtime.getURL('icons/icon128.png')}
          onError={(e) => { (e.currentTarget as HTMLImageElement).src = chrome.runtime.getURL('icons/icon128.png'); }}
        />
        <HeaderText theme={theme} style={{ width: '90%' }}>
          {thirdPartyAppRequestData?.appName}
        </HeaderText>
        <Text theme={theme} style={{ marginBottom: '1rem' }}>
          {thirdPartyAppRequestData?.domain}
        </Text>
        <PermissionsContainer theme={theme}>
          <Permission>
            <CheckMark style={{ marginRight: '1rem' }} src={greenCheck} />
            <Text style={{ color: theme.white, margin: 0, textAlign: 'left' }}>View your wallet public keys</Text>
          </Permission>
          <Permission>
            <CheckMark style={{ marginRight: '1rem' }} src={greenCheck} />
            <Text style={{ color: theme.white, margin: 0, textAlign: 'left' }}>Request approval for transactions</Text>
          </Permission>
        </PermissionsContainer>
        <Button
          theme={theme}
          type="primary"
          label="Connect"
          onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation();
            handleConnectDecision(true);
            onDecision();
          }}
        />
        <Button
          theme={theme}
          type="secondary-outline"
          label="Cancel"
          onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation();
            handleConnectDecision(false);
            onDecision();
          }}
        />
      </Container>
    </Show>
  );
};
