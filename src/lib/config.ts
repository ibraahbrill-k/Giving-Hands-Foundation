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

export type Network = 'mpesa' | 'airtel' | null;

/** Detect Safaricom vs Airtel from a Kenyan phone number. */
export function detectNetwork(phone: string): Network {
  let n = phone.replace(/\D/g, '');
  if (n.startsWith('0')) n = n.slice(1);
  if (n.startsWith('254')) n = n.slice(3);
  const p = n.slice(0, 2);
  // Safaricom: 0700-0729, 0740-0749, 0110-0119, 0100-0109
  if (['70', '71', '72', '74', '10', '11'].includes(p)) return 'mpesa';
  // Airtel Money: 0730-0739, 0750-0759
  if (['73', '75'].includes(p)) return 'airtel';
  return null;
}
