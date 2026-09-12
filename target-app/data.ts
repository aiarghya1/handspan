/**
 * Fixture data for the mock core-servicing app.
 *
 * All names, addresses and numbers here are invented. Nothing in this file is
 * real PII; the app exists so the automation has something PII-shaped to be
 * careful with.
 */

export interface Member {
  memberNumber: string;
  name: string;
  status: 'Active' | 'Dormant' | 'Closed';
  branch: string;
  taxId: string; // fake SSN-shaped value, exercises redaction
  shares: Array<{ suffix: string; product: string; balance: number; available: number }>;
  restricted?: boolean;
}

export const MEMBERS: Record<string, Member> = {
  '12345': {
    memberNumber: '12345',
    name: 'DELACROIX, R M',
    status: 'Active',
    branch: '004 - RIVERSIDE',
    taxId: '412-88-0031',
    shares: [
      { suffix: '0001', product: 'REGULAR SHARE SAVINGS', balance: 4182.55, available: 4082.55 },
      { suffix: '0075', product: 'PRIMARY CHECKING', balance: 913.2, available: 913.2 },
      { suffix: '0200', product: 'MONEY MARKET', balance: 25000.0, available: 25000.0 },
    ],
  },
  '23456': {
    memberNumber: '23456',
    name: 'OKONKWO, A',
    status: 'Active',
    branch: '001 - MAIN',
    taxId: '523-19-7744',
    shares: [
      { suffix: '0001', product: 'REGULAR SHARE SAVINGS', balance: 87.04, available: 62.04 },
    ],
  },
  '34567': {
    memberNumber: '34567',
    name: 'HALVORSEN, T J',
    status: 'Dormant',
    branch: '004 - RIVERSIDE',
    taxId: '601-44-2290',
    shares: [
      { suffix: '0001', product: 'REGULAR SHARE SAVINGS', balance: 0.0, available: 0.0 },
      { suffix: '0090', product: 'VACATION CLUB', balance: 1200.0, available: 1200.0 },
    ],
  },
  '77777': {
    memberNumber: '77777',
    name: 'RESTRICTED RECORD',
    status: 'Active',
    branch: '000 - EXEC',
    taxId: '000-00-0000',
    shares: [],
    restricted: true,
  },
};

export const PRODUCTS = [
  { code: 'SV02', label: 'SECONDARY SHARE SAVINGS' },
  { code: 'VC01', label: 'VACATION CLUB' },
  { code: 'HD01', label: 'HOLIDAY CLUB' },
];
