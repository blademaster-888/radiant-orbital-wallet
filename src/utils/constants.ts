export const RXD_DECIMAL_CONVERSION = 100000000;
export const RXD20_INDEX_FEE = 1000;
export const FEE_PER_BYTE = 10000;
export const MAX_BYTES_PER_TX = 1000000; // 1MB
export const MAX_FEE_PER_TX = MAX_BYTES_PER_TX * FEE_PER_BYTE;
export const P2PKH_INPUT_SIZE = 148;
export const P2PKH_OUTPUT_SIZE = 34;
export const DUST = 10;
export const INACTIVITY_LIMIT = 10 * 60 * 1000; // 10 minutes
export const SNACKBAR_TIMEOUT = 3 * 1000; // 2.5 seconds

export const DEFAULT_WALLET_PATH = "m/44'/512'/0'/0/0";
export const DEFAULT_IDENTITY_PATH = "m/44'/512'/0'/1/0";

export const LEGACY_WALLET_PATH = "m/44'/0'/0'/0/0";
export const LEGACY_IDENTITY_PATH = "m/44'/0'/0'/1/0";

// Featured 3rd party integrations
export const featuredApps = [
  {
    name: 'Orbital Market',
    link: 'https://orbitalmarket.trade',
    icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIj48cmVjdCB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHJ4PSI2IiBmaWxsPSIjMWExYTJlIi8+PHBhdGggZD0iTTEyIDNMMyA3LjVsOSA0LjUgOS00LjVMMTIgM3pNMyAxNi41bDkgNC41IDktNC41TTMgMTJsOSA0LjUgOS00LjUiIHN0cm9rZT0iI2Y1OWUwYiIgc3Ryb2tlLXdpZHRoPSIxLjgiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIgZmlsbD0ibm9uZSIvPjwvc3ZnPg==',
  },
];
