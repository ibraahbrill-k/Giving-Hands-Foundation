export const FUNDRAISER = {
  title: "Medical Fund for Sylvia's Mum",
  subtitle: 'Medical fund for Sylvia\u2019s Mum',
  description:
    'Your contribution can help cover urgent medical expenses. Every amount, big or small, makes a difference.',
  closingNote: 'Thank you for standing with the family during this difficult time.',
  beneficiaryName: 'Sylvia\u2019s Mum',
  targetKes: 150_000,
};

export const PRESET_AMOUNTS = [200, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 20_000];

export const MANUAL_MPESA = {
  number: '0728 249 030',
  name: 'Sylvia\u2019s Mum',
};

export function formatKes(amount: number): string {
  return `KSh ${amount.toLocaleString('en-KE')}`;
}
