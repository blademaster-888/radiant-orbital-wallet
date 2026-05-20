import validate from 'bitcoin-address-validation';
import { logger } from '../logger';
import { useEffect, useState } from 'react';
import styled from 'styled-components';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { PageLoader } from '../components/PageLoader';
import { QrCode } from '../components/QrCode';
import {
  ButtonContainer,
  ConfirmContent,
  FormContainer,
  HeaderText,
  ReceiveContent,
  Text,
} from '../components/Reusable';
import { Show } from '../components/Show';
import { useBottomMenu } from '../hooks/useBottomMenu';
import { useSnackbar } from '../hooks/useSnackbar';
import { useTheme } from '../hooks/useTheme';
import { useWeb3Context } from '../hooks/useWeb3Context';
import { sleep } from '../utils/sleep';
import { RXD20Id } from '../components/RXD20Id';
import { TbCopy as CopyIcon } from 'react-icons/tb';
import { TopNav } from '../components/TopNav';
import { AssetRow } from '../components/AssetRow';
import { formatNumberWithCommasAndDecimals } from '../utils/format';
import { useRadiantTokens } from '../hooks/useRadiantTokens';
import { useLiveQuery } from 'dexie-react-hooks';
import { Token, db } from '../db';
import { TokenImage } from '../components/TokenImage';
import { iOutpoint, reverseOutpoint } from '../utils/outpoint';
import { rxdAddress } from '../signals';

const FTList = styled.div`
  position: absolute;
  top: 4.25rem;
  bottom: 9rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  overflow-y: auto;
  overflow-x: hidden;
  width: 100%;
`;

const NoInscriptionWrapper = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
`;

export const CheckBox = styled.div`
  margin: 0.5rem 0.5rem;
`;

const ContentWrapper = styled.div`
  width: 100%;
`;

const TransferFTHeader = styled(HeaderText)`
  overflow: hidden;
  max-width: 16rem;
  white-space: nowrap;
  text-overflow: ellipsis;
  margin: 0;
`;

export const OrdButtonContainer = styled(ButtonContainer)`
  position: fixed;
  bottom: 3.75rem;
`;

export const FTHeader = styled.div`
  display: flex;
  align-items: center;
  width: 100%;
  margin-left: 1rem;
`;

const TokenIcon = styled(TokenImage)`
  max-width: 2.5rem;
  max-height: 2.5rem;
  border-radius: 50%;
  object-fit: cover;
  margin-bottom: 0.5rem;
`;

const Balance = styled(Text)`
  font-size: 0.85rem;
  white-space: pre-wrap;
  margin: 0;
  width: fit-content;
  cursor: pointer;
  text-align: center;
  width: 100%;
`;

const FTContainer = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-direction: row;
  width: 80%;
  margin: 0 0 0.75rem 0;
  padding: 0 0;
`;

const CopyAddressWrapper = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  margin: 2rem 0;
`;

const StyledCopy = styled(CopyIcon)`
  width: 1rem;
  height: 1rem;
  margin-right: 0.25rem;
  color: white;
`;

type PageState = 'main' | 'receive' | 'transfer' | 'list' | 'cancel' | 'sendRXD20';

export const TokenWallet = () => {
  const { theme } = useTheme();
  const { setSelected } = useBottomMenu();
  const [pageState, setPageState] = useState<PageState>('main');
  const fts = useLiveQuery(async () => ({
    initialized: true,
    data: await db.token.where({ type: 'ft' }).toArray(),
  })) || {
    initialized: false,
    data: [],
  };

  const { syncTokens, sendFt, isProcessing, setIsProcessing } = useRadiantTokens();
  //const [tabIndex, selectTab] = useState(1);
  const [receiveAddress, setReceiveAddress] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [successTxId, setSuccessTxId] = useState('');
  const { addSnackbar, message } = useSnackbar();
  const { isPasswordRequired } = useWeb3Context();

  const [token, setToken] = useState<Token | null>(null);
  const [tokenSendAmount, setTokenSendAmount] = useState<bigint | null>(null);

  useEffect(() => {
    setSelected('tokens');
  }, [setSelected]);

  useEffect(() => {
    logger.log('syncTokens', rxdAddress.value);
    syncTokens();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!successTxId) return;
    // if (!message) {
    resetSendState();
    setPageState('main');
    // }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [successTxId, message]);

  const resetSendState = () => {
    setReceiveAddress('');
    setPasswordConfirm('');
    setSuccessTxId('');
    setIsProcessing(false);
    setTokenSendAmount(null);
    /*
    // Conflicts with DB update after sending
    // Is this needed?
    setTimeout(() => {
      syncTokens();
    }, 500);*/
  };

  const getErrorMessage = (key: string) => {
    const errorMessages = {
      'invalid-password': 'Invalid Password!',
      'no-keys': 'No keys were found!',
      'insufficient-funds': 'Insufficient Funds!',
      'fee-too-high': 'Miner fee too high!',
      'token-details': 'Could not gather token details!',
      'broadcast-error': 'There was an error broadcasting the tx!',
      'Incorrect password': 'Incorrect password',
      unknown: 'An unknown error has occurred! Try again.',
    };
    return errorMessages[key as keyof typeof errorMessages] || errorMessages.unknown;
  };

  const handleTransferOrdinal = async (e: React.FormEvent<HTMLFormElement>) => {
    /*
    e.preventDefault();
    setIsProcessing(true);

    await sleep(25);
    if (!validate(receiveAddress)) {
      addSnackbar('You must enter a valid Radiant address.', 'info');
      setIsProcessing(false);
      return;
    }

    if (!passwordConfirm && isPasswordRequired) {
      addSnackbar('You must enter a password!', 'error');
      setIsProcessing(false);
      return;
    }

    const transferRes = await transferOrdinal(receiveAddress, ordinalOutpoint, passwordConfirm);

    if (!transferRes.txid || transferRes.error) {
      //const errorMessage = getErrorMessage(transferRes);
      //addSnackbar(errorMessage, 'error');
      return;
    }

    setSuccessTxId(transferRes.txid);
    addSnackbar('Transfer Successful!', 'success');
    */
  };

  const handleSendRXD20 = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsProcessing(true);

    await sleep(25);
    if (!validate(receiveAddress)) {
      addSnackbar('You must enter a valid Radiant address.', 'info');
      setIsProcessing(false);
      return;
    }

    if (!passwordConfirm && isPasswordRequired) {
      addSnackbar('You must enter a password!', 'error');
      setIsProcessing(false);
      return;
    }

    if (token === null || tokenSendAmount === null) {
      setIsProcessing(false);
      return;
    }

    const response = await sendFt(token, receiveAddress, BigInt(tokenSendAmount), passwordConfirm);
    setIsProcessing(false);

    if (!response.txid || response.error) {
      const message = getErrorMessage(response.error);

      addSnackbar(message, 'error');
      return;
    }

    setSuccessTxId(response.txid);
    addSnackbar('Tokens Sent!', 'success');
  };

  const handleCopyToClipboard = () => {
    navigator.clipboard.writeText(rxdAddress.value).then(() => {
      addSnackbar('Copied!', 'success');
    });
  };

  const userSelectedAmount = (amount: bigint, token: Token) => {
    if (amount > token.balance) {
      setTimeout(() => {
        setTokenSendAmount(token.balance);
      }, 500);
    } else {
      setTokenSendAmount(amount);
    }
  };

  const ft = (
    <>
      <Show
        when={fts.initialized && fts.data.length > 0}
        whenFalseContent={
          <NoInscriptionWrapper>
            <Text
              style={{
                color: theme.gray,
                fontSize: '1rem',
              }}
            >
              You don't have any tokens
            </Text>
          </NoInscriptionWrapper>
        }
      >
        <FTList>
          <div style={{ width: '100%' }}>
            {fts.data.map((token, i) => (
              <div
                key={`${token.ref}${i}`}
                style={{ display: 'flex', justifyContent: 'center', width: '100%' }}
                onClick={async () => {
                  setToken(token);
                  setPageState('sendRXD20');
                }}
              >
                <AssetRow
                  icon={<TokenImage token={token} />}
                  balance={Number(token.balance)}
                  isPhotons
                  ticker={token.ticker}
                />
              </div>
            ))}
          </div>
        </FTList>
      </Show>
      <OrdButtonContainer>
        <Button theme={theme} type="primary" label="Receive" onClick={() => setPageState('receive')} />
      </OrdButtonContainer>
    </>
  );

  const receive = (
    <ReceiveContent>
      <HeaderText style={{ marginTop: '1rem', marginBottom: '1.25rem' }} theme={theme}>
        Receive Tokens
      </HeaderText>
      <QrCode address={rxdAddress.value} onClick={handleCopyToClipboard} />
      <CopyAddressWrapper onClick={handleCopyToClipboard}>
        <StyledCopy />
        <Text theme={theme} style={{ margin: '0', color: theme.white, fontSize: '0.75rem' }}>
          {rxdAddress.value}
        </Text>
      </CopyAddressWrapper>
      <Button
        label="Go back"
        theme={theme}
        type="secondary"
        onClick={() => {
          setPageState('main');
          setTimeout(() => {
            syncTokens();
          }, 500);
        }}
      />
    </ReceiveContent>
  );

  const transfer = (
    <ContentWrapper>
      <ConfirmContent>
        <HeaderText style={{ fontSize: '1.35rem' }} theme={theme}>
          Transfer NFT
        </HeaderText>
        <FormContainer noValidate onSubmit={(e) => handleTransferOrdinal(e)}>
          <Input
            theme={theme}
            placeholder="Receive Address"
            type="text"
            name="address"
            onChange={(e) => setReceiveAddress(e.target.value)}
            value={receiveAddress}
          />
          <Show when={isPasswordRequired}>
            <Input
              theme={theme}
              placeholder="Password"
              name="password"
              type="password"
              value={passwordConfirm}
              onChange={(e) => setPasswordConfirm(e.target.value)}
            />
          </Show>
          <Button theme={theme} type="primary" label="Transfer Now" disabled={isProcessing} isSubmit />
        </FormContainer>
        <Button
          theme={theme}
          type="secondary"
          label="Go back"
          onClick={() => {
            setPageState('main');
            resetSendState();
          }}
        />
      </ConfirmContent>
    </ContentWrapper>
  );

  // Add tabs back when NFTs are implemented
  /*const main = (
    <Tabs tabIndex={tabIndex} selectTab={selectTab} theme={theme}>
      <Tabs.Panel theme={theme} label="NFT">
        {nft}
      </Tabs.Panel>
      <Tabs.Panel theme={theme} label="Tokens">
        {ft}
      </Tabs.Panel>
    </Tabs>
  );*/

  const main = ft;

  const sendFTView = (
    <Show when={token !== null}>
      {token ? (
        <ConfirmContent>
          <TokenIcon token={token} />
          <TransferFTHeader theme={theme}>Send {token.ticker}</TransferFTHeader>
          <FTContainer>
            <Balance theme={theme} onClick={() => userSelectedAmount(token.balance, token)}>
              {`Balance: ${formatNumberWithCommasAndDecimals(Number(token.balance), 0)}`}
            </Balance>
          </FTContainer>
          <FTContainer>
            <RXD20Id
              theme={theme}
              id={iOutpoint(reverseOutpoint(token.ref))}
              onCopyTokenId={() => {
                addSnackbar('Copied', 'success');
              }}
            ></RXD20Id>
          </FTContainer>
          <FormContainer noValidate onSubmit={(e) => handleSendRXD20(e)}>
            <Input
              theme={theme}
              name="address"
              placeholder="Receive Address"
              type="text"
              onChange={(e) => setReceiveAddress(e.target.value)}
              value={receiveAddress}
            />
            <Input
              name="amt"
              theme={theme}
              placeholder="Enter Token Amount"
              type="number"
              step={'1'}
              value={tokenSendAmount?.toString() || ''}
              onChange={(e) => {
                const inputValue = e.target.value;

                if (inputValue === '') {
                  setTokenSendAmount(null);
                } else {
                  userSelectedAmount(BigInt(parseInt(inputValue, 10)), token);
                }
              }}
            />
            <Show when={isPasswordRequired}>
              <Input
                theme={theme}
                name="password"
                placeholder="Password"
                type="password"
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
              />
            </Show>
            <Button theme={theme} type="primary" label="Send" disabled={isProcessing} isSubmit />
          </FormContainer>
          <Button
            theme={theme}
            type="secondary"
            label="Go back"
            style={{ marginTop: '0.5rem' }}
            disabled={isProcessing}
            onClick={() => {
              setTokenSendAmount(null);
              setPageState('main');
              resetSendState();
            }}
          />
        </ConfirmContent>
      ) : (
        <></>
      )}
    </Show>
  );

  return (
    <>
      <TopNav />
      <Show when={isProcessing && pageState === 'main'}>
        <PageLoader theme={theme} message="Loading tokens..." />
      </Show>
      <Show when={isProcessing && pageState === 'transfer'}>
        <PageLoader theme={theme} message="Transferring token..." />
      </Show>
      <Show when={isProcessing && pageState === 'sendRXD20'}>
        <PageLoader theme={theme} message="Sending tokens..." />
      </Show>
      <Show when={!isProcessing && pageState === 'main'}>{main}</Show>
      <Show when={!isProcessing && pageState === 'receive'}>{receive}</Show>
      <Show when={!isProcessing && pageState === 'transfer'}>{transfer}</Show>
      <Show when={!isProcessing && pageState === 'sendRXD20'}>{sendFTView}</Show>
    </>
  );
};
