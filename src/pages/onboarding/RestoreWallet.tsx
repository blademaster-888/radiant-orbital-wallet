import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import styled from 'styled-components';
import otherWallet from '../../assets/other-wallet.svg';
import wifWallet from '../../assets/wif-wallet.svg';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { PageLoader } from '../../components/PageLoader';
import { HeaderText, Text, OrbitalLogo } from '../../components/Reusable';
import { Show } from '../../components/Show';
import { ToggleSwitch } from '../../components/ToggleSwitch';
import { WalletRow } from '../../components/WalletRow';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useTheme } from '../../hooks/useTheme';
import { ColorThemeProps } from '../../theme';
import { sleep } from '../../utils/sleep';
import { generateSeedAndStoreEncrypted } from '../../utils/crypto';
import { unlock } from '../../utils/keyring';
import { LEGACY_WALLET_PATH, LEGACY_IDENTITY_PATH } from '../../utils/constants';

export type SupportedWalletImports = 'wif';

const Content = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
`;

const FormContainer = styled.form`
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  margin: 0;
  padding: 0;
  border: none;
  background: none;
`;

const SeedInput = styled.textarea<ColorThemeProps & { $isExpert: boolean }>`
  background-color: ${({ theme }) => theme.darkAccent};
  border-radius: 0.5rem;
  border: 1px solid ${({ theme }) => theme.gray + '50'};
  width: 80%;
  height: 4rem;
  font-size: 0.85rem;
  font-family: 'Inter', Arial, Helvetica, sans-serif;
  padding: 1rem;
  margin: 0.5rem;
  outline: none;
  color: ${({ theme }) => theme.white + '80'};
  resize: none;

  &::placeholder {
    color: ${({ theme }) => theme.white + '80'};
  }
`;

const ExpertImportWrapper = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 90%;
`;

const WalletWrapper = styled.div`
  display: flex;
  align-items: center;
`;

const WalletLogo = styled.img`
  width: auto;
  height: 2.25rem;
`;

const WalletText = styled(Text)`
  margin: 0 0 0 1rem;
  text-align: left;
  color: ${({ theme }) => theme.white};
  font-weight: 600;
`;

export const RestoreWallet = () => {
  const { theme } = useTheme();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  // Starting at step 2. Step 1 can be reenabled if needed.
  const [step, setStep] = useState(2);
  const [seedWords, setSeedWords] = useState<string>('');
  const { addSnackbar } = useSnackbar();
  const { hideMenu, showMenu } = useBottomMenu();
  const [loading, setLoading] = useState(false);
  const [isExpertImport, setIsExpertImport] = useState(false);
  const [isLegacyImport, setIsLegacyImport] = useState(false);
  const [importWallet, setImportWallet] = useState<SupportedWalletImports | undefined>();
  const [walletDerivation, setWalletDerivation] = useState<string | null>(null);
  const [identityDerivation, setIdentityDerivation] = useState<string | null>(null);
  useEffect(() => {
    hideMenu();

    return () => {
      showMenu();
    };
  }, [hideMenu, showMenu]);

  const handleExpertToggle = () => setIsExpertImport(!isExpertImport);

  const handleLegacyToggle = () => {
    const next = !isLegacyImport;
    setIsLegacyImport(next);
    if (next) {
      setWalletDerivation(LEGACY_WALLET_PATH);
      setIdentityDerivation(LEGACY_IDENTITY_PATH);
    } else {
      setWalletDerivation(null);
      setIdentityDerivation(null);
    }
  };

  const handleRestore = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    if (password.length < 8) {
      setLoading(false);
      addSnackbar('The password must be at least 8 characters!', 'error');
      return;
    }

    if (password !== passwordConfirm) {
      setLoading(false);
      addSnackbar('The passwords do not match!', 'error');
      return;
    }

    // Some artificial delay for the loader
    await sleep(50);
    const mnemonic = await generateSeedAndStoreEncrypted(password, seedWords, walletDerivation, identityDerivation);
    
    if (!mnemonic) {
      addSnackbar('An error occurred while restoring the wallet!', 'error');
      return;
    }

    await unlock(password);

    setLoading(false);
    setStep(4);
  };

  const handleWalletSelection = (wallet?: SupportedWalletImports) => {
    setImportWallet(wallet);
    if (wallet === 'wif') {
      navigate('/import-wallet');
      return;
    }
    setStep(2);
  };

  const passwordStep = (
    <>
      <Content>
        <HeaderText theme={theme}>Create a password</HeaderText>
        <Text theme={theme}>This is used to unlock your wallet.</Text>
        <FormContainer onSubmit={handleRestore}>
          <Input
            theme={theme}
            placeholder="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Input
            theme={theme}
            placeholder="Confirm Password"
            type="password"
            value={passwordConfirm}
            onChange={(e) => setPasswordConfirm(e.target.value)}
            style={{ marginBottom: '2rem' }}
          />
          <Button theme={theme} type="primary" label="Finish" isSubmit />
          <Button theme={theme} type="secondary" label="Go back" onClick={() => setStep(2)} />
        </FormContainer>
      </Content>
    </>
  );

  const enterSeedStep = (
    <>
      <Content>
        <HeaderText theme={theme}>Restore wallet</HeaderText>
        <Text theme={theme} style={{ marginBottom: '1rem', width: '90%' }}>
          Enter your seed phrase
        </Text>
        <FormContainer onSubmit={() => setStep(3)}>
          <SeedInput
            theme={theme}
            placeholder="Enter secret recovery words"
            onChange={(e) => setSeedWords(e.target.value)}
            $isExpert={isExpertImport}
          />
          <Show when={!importWallet}>
            <ExpertImportWrapper>
              <ToggleSwitch theme={theme} on={isLegacyImport} onChange={handleLegacyToggle} />
              <Text theme={theme} style={{ margin: '0 0 0 0.5rem', textAlign: 'left' }}>
                Legacy wallet (coin type 0)
              </Text>
            </ExpertImportWrapper>
          </Show>
          <Show when={isExpertImport}>
            <Input
              theme={theme}
              placeholder="Wallet Derivation ex. m/44'/512'/0'/0/0"
              type="text"
              value={walletDerivation ?? ''}
              onChange={(e) => setWalletDerivation(e.target.value)}
              style={{ margin: '0.1rem', width: '85%' }}
            />
            <Input
              theme={theme}
              placeholder="Identity Derivation ex. m/44'/512'/0'/1/0"
              type="text"
              value={identityDerivation ?? ''}
              onChange={(e) => setIdentityDerivation(e.target.value)}
              style={{ margin: '0.1rem 0 1rem', width: '85%' }}
            />
          </Show>
          <Show when={!importWallet}>
            <ExpertImportWrapper>
              <ToggleSwitch theme={theme} on={isExpertImport} onChange={handleExpertToggle} />
              <Text theme={theme} style={{ margin: '0 0 0 0.5rem', textAlign: 'left' }}>
                Use custom derivations
              </Text>
            </ExpertImportWrapper>
          </Show>
          <Text theme={theme} style={{ margin: '1rem 0 1rem' }}>
            Make sure you are in a safe place and no one is watching.
          </Text>
          <Button theme={theme} type="primary" label="Next" isSubmit />
          <Button theme={theme} type="secondary" label="Go back" onClick={() => navigate('/')} />
        </FormContainer>
      </Content>
    </>
  );

  const availableWallets = (wallets: (SupportedWalletImports | undefined)[]) => {
    return wallets.map((wallet) => {
      return (
        <WalletRow
          key={window.crypto.randomUUID()}
          onClick={() => handleWalletSelection(wallet)}
          element={
            <>
              <Show when={!wallet}>
                <WalletWrapper>
                  <WalletLogo src={otherWallet} />
                  <WalletText theme={theme}>Restore with seed phrase</WalletText>
                </WalletWrapper>
              </Show>
              <Show when={wallet === 'wif'}>
                <WalletWrapper>
                  <WalletLogo src={wifWallet} />
                  <WalletText theme={theme}>Restore with private key</WalletText>
                </WalletWrapper>
              </Show>
            </>
          }
        />
      );
    });
  };

  const selectImportWallet = (
    <>
      <Content>
        <HeaderText theme={theme}>Restore a Wallet</HeaderText>
        <Text theme={theme} style={{ marginBottom: '1rem', width: '90%' }}>
          Select the wallet you'd like to restore from
        </Text>
        {availableWallets([undefined, 'wif'])}
        <Button theme={theme} type="secondary" label="Go back" onClick={() => navigate('/')} />
      </Content>
    </>
  );

  const successStep = (
    <>
      <Content>
        <OrbitalLogo />
        <HeaderText theme={theme}>Success!</HeaderText>
        <Text theme={theme} style={{ marginBottom: '1rem' }}>
          Your wallet has been restored.
        </Text>
        <Button
          theme={theme}
          type="primary"
          label="Enter"
          onClick={() => {
            window.location.reload();
          }}
        />
      </Content>
    </>
  );

  return (
    <>
      <Show when={loading}>
        <PageLoader theme={theme} message="Restoring Wallet..." />
      </Show>
      <Show when={!loading && step === 1}>{selectImportWallet}</Show>
      <Show when={!loading && step === 2}>{enterSeedStep}</Show>
      <Show when={!loading && step === 3}>{passwordStep}</Show>
      <Show when={!loading && step === 4}>{successStep}</Show>
    </>
  );
};
