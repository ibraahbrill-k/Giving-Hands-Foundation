import { useCallback, useEffect, useRef, useState } from 'react';
import { FUNDRAISER, MANUAL_MPESA, PRESET_AMOUNTS, detectNetwork, formatKes } from './lib/config';
import { fetchRaisedTotal, initiatePayment, verifyPayment } from './lib/supabase';

type Phase = 'idle' | 'initiating' | 'awaiting-pin' | 'success' | 'failed' | 'error';

function NetworkIcon({ net, className = 'h-6 w-auto' }: { net: 'mpesa' | 'airtel'; className?: string }) {
  return (
    <img
      src={net === 'mpesa' ? '/images/mpesa.png' : '/images/airtel.png'}
      alt={net === 'mpesa' ? 'M-Pesa' : 'Airtel Money'}
      className={className}
      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
    />
  );
}

function CrossMark({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6V3z" />
    </svg>
  );
}

export default function App() {
  const [raisedCents, setRaisedCents] = useState(0);
  const [amount, setAmount] = useState(500);
  const [customAmount, setCustomAmount] = useState('');
  const [phone, setPhone] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [statusText, setStatusText] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [paidAmount, setPaidAmount] = useState(0);
  const [paidReference, setPaidReference] = useState('');
  const [method, setMethod] = useState<'mobile' | 'card'>('mobile');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Returning from Paystack card checkout: ?reference=... in the URL
  useEffect(() => {
    const ref = new URLSearchParams(window.location.search).get('reference');
    if (ref && /^SM-\d{13}-[a-f0-9]{8}$/.test(ref)) {
      window.history.replaceState({}, '', window.location.pathname);
      setPhase('awaiting-pin');
      setStatusText('Confirming your payment...');
      pollRef.current = null;
      // reuse the polling logic
      (async () => {
        for (let i = 0; i < 15; i++) {
          try {
            const res = await verifyPayment(ref);
            if (res.status === 'success') {
              setPaidReference(ref);
              if (res.amount) setPaidAmount(Math.round(res.amount / 100));
              setPhase('success');
              fetchRaisedTotal().then(setRaisedCents).catch(() => {});
              return;
            }
            if (res.status === 'failed' || res.status === 'abandoned') {
              setPhase('failed');
              setStatusText('The card payment was not completed.');
              return;
            }
          } catch {
            /* keep checking */
          }
          await new Promise((r) => setTimeout(r, 4000));
        }
        setPhase('failed');
        setStatusText('We could not confirm the payment. If you were charged, contact us with reference ' + ref + '.');
      })();
    }
  }, []);

  useEffect(() => {
    fetchRaisedTotal()
      .then(setRaisedCents)
      .catch(() => {});
  }, []);

  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
    },
    []
  );

  const effectiveAmount =
    customAmount !== '' ? Math.round(Number(customAmount.replace(/\D/g, '')) || 0) : amount;

  const raisedKes = Math.floor(raisedCents / 100);
  const progress = Math.min(1, raisedKes / FUNDRAISER.targetKes);
  const remainingKes = Math.max(0, FUNDRAISER.targetKes - raisedKes);

  const pollForSuccess = useCallback((reference: string) => {
    setPhase('awaiting-pin');
    setStatusText('An M-Pesa prompt has been sent to your phone. Enter your PIN to confirm.');
    let attempts = 0;
    pollRef.current = setInterval(async () => {
      attempts += 1;
      if (attempts > 45) { // ~3 minutes — matches Paystack's 180s prompt window
        clearInterval(pollRef.current!);
        setPhase('failed');
        setStatusText(
          `The request timed out. If you already entered your PIN, your contribution is safe — reach out to us with reference ${reference}.`
        );
        return;
      }
      try {
        const res = await verifyPayment(reference);
        if (res.status === 'success') {
          clearInterval(pollRef.current!);
          setPaidReference(reference);
          if (res.amount) setPaidAmount(Math.round(res.amount / 100));
          setPhase('success');
          setStatusText('');
          fetchRaisedTotal()
            .then(setRaisedCents)
            .catch(() => {});
        } else if (res.status === 'failed' || res.status === 'abandoned') {
          clearInterval(pollRef.current!);
          setPhase('failed');
          setStatusText(
            'The payment was not completed. No money has left your account unless you confirmed the prompt.'
          );
        }
      } catch {
        // transient network error — keep polling
      }
    }, 4000);
  }, []);

  const onDonate = useCallback(async () => {
    if (effectiveAmount < 50) {
      setPhase('error');
      setStatusText('Please choose an amount of at least KSh 50.');
      return;
    }
    setPhase('initiating');
    setStatusText('');
    try {
      const res = await initiatePayment(
        effectiveAmount,
        method === 'card' ? '' : phone,
        method
      );
      if (res.error) {
        setPhase('error');
        setStatusText(res.error);
        return;
      }

      if (method === 'card') {
        // Paystack Inline popup — secure card form hosted by Paystack
        const PaystackPop = (window as any).PaystackPop;
        if (!PaystackPop) {
          setPhase('error');
          setStatusText('Payment window could not load. Please check your connection.');
          return;
        }
        const handler = PaystackPop.setup({
          key: 'pk_live_1914b9371b9787974916c7f15d3f885c5c943894',
          email: res.email,
          amount: effectiveAmount * 100,
          currency: 'KES',
          ref: res.reference,
          callback: (response: any) => {
            setPaidAmount(effectiveAmount);
            pollForSuccess(response.reference);
          },
          onClose: () => {
            setPhase('idle');
            setStatusText('');
          },
        });
        handler.openIframe();
        return;
      }

      if (!res.reference) {
        setPhase('error');
        setStatusText('Could not start the payment. Please try again.');
        return;
      }
      setPaidAmount(effectiveAmount);
      pollForSuccess(res.reference);
    } catch {
      setPhase('error');
      setStatusText('Network error. Please check your connection and try again.');
    }
  }, [effectiveAmount, phone, method, pollForSuccess]);

  const onShare = useCallback(async () => {
    const url = window.location.href;
    if (navigator.share) {
      try {
        await navigator.share({
          title: FUNDRAISER.title,
          text: `${FUNDRAISER.description} ${url}`,
        });
        return;
      } catch {
        /* user cancelled */
      }
    }
    await navigator.clipboard.writeText(`${FUNDRAISER.title} — ${url}`);
    setStatusText('Link copied to clipboard. Thank you for sharing.');
    setTimeout(() => {
      setStatusText('');
      setPhase('idle');
    }, 3000);
  }, []);

  const busy = phase === 'initiating' || phase === 'awaiting-pin';
  const network = detectNetwork(phone);

  const onDonateAgain = useCallback(() => {
    setPhase('idle');
    setPhone('');
    setStatusText('');
    window.scrollTo({ top: 0 });
  }, []);
  const spinner = (
    <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
  );

  return (
    <div className="min-h-screen bg-white font-sans text-stone-800 antialiased">
      {/* Sticky header */}
      <header className="sticky top-0 z-50 border-b border-stone-200/80 bg-white/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-6">
          <a href="#top" className="flex items-center gap-2.5">
            <img
              src="/images/logo.png"
              alt="Better Life logo"
              className="h-9 w-9 rounded-lg object-contain"
            />
            <span className="text-[15px] font-bold tracking-tight text-stone-900">
              Better Life
            </span>
          </a>
          <a
            href="#donate"
            className="rounded-full bg-brand-900 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
          >
            Donate
          </a>
        </div>
      </header>

      {phase === 'success' ? (
        /* Thank-you screen */
        <section className="bg-stone-50">
          <div className="mx-auto flex max-w-xl flex-col items-center px-6 py-16 text-center sm:py-24">
            <div className="relative flex h-24 w-24 animate-pop-in items-center justify-center">
            <span className="absolute inset-0 rounded-full border-2 border-brand-500 animate-ring-pulse" />
            <span className="flex h-20 w-20 items-center justify-center rounded-full bg-white shadow-[inset_0_0_0_2px_rgba(255,255,255,1)]">
              <svg viewBox="0 0 52 52" className="h-14 w-14" aria-hidden="true">
                <circle
                  cx="26" cy="26" r="24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  className="text-brand-600 animate-draw-circle"
                  strokeLinecap="round"
                  transform="rotate(-90 26 26)"
                />
                <path
                  d="M15 27l8 8 15-16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-brand-900 animate-draw-tick"
                />
              </svg>
            </span>
          </div>

          <h1 className="mt-7 text-3xl font-extrabold tracking-tight text-stone-900 sm:text-4xl animate-fade-up" style={{ animationDelay: '0.5s' }}>
            Asante sana! Thank you so much.
          </h1>
          <p className="mt-4 max-w-md text-lg leading-relaxed text-stone-600 animate-fade-up" style={{ animationDelay: '0.65s' }}>
            Your donation of{' '}
            <span className="font-bold text-stone-900">{formatKes(paidAmount)}</span> has been
            received. Your kindness brings real relief to Sylvia's Mum and the whole family
            during this difficult time —{' '}
            <span className="font-semibold italic text-stone-700">Mungu akubariki sana.</span>
          </p>

          <div className="mt-10 w-full rounded-2xl border border-stone-200 bg-white animate-fade-up" style={{ animationDelay: '0.8s' }}>
              <div className="flex items-center justify-between border-b border-stone-200 px-6 py-4">
                <span className="text-sm font-medium text-stone-500">Amount received</span>
                <span className="text-[15px] font-bold text-stone-900">
                  {formatKes(paidAmount)}
                </span>
              </div>
              <div className="px-6 py-4 text-left">
                <span className="block text-sm font-medium text-stone-500">Reference</span>
                <span className="mt-0.5 block break-all font-mono text-sm text-stone-800">
                  {paidReference}
                </span>
              </div>
            </div>
            <p className="mt-3 w-full text-left text-xs leading-relaxed text-stone-400">
              Keep this reference for your records. An M-Pesa confirmation SMS has also been sent
              to your phone by Safaricom.
            </p>

            <div className="mt-8 flex w-full flex-col gap-3 sm:flex-row animate-fade-up" style={{ animationDelay: '0.95s' }}>
              <button
                type="button"
                onClick={onDonateAgain}
                className="flex-1 rounded-lg border border-stone-300 bg-white py-3 text-base font-semibold text-stone-700 transition-colors hover:border-brand-600 hover:text-brand-700"
              >
                Make another donation
              </button>
              <button
                type="button"
                onClick={onShare}
                className="flex-1 rounded-lg bg-brand-900 py-3 text-base font-bold text-white transition-colors hover:bg-brand-700"
              >
                Share this fundraiser
              </button>
            </div>

            <p className="mt-10 max-w-md text-sm leading-relaxed text-stone-500 animate-fade-up" style={{ animationDelay: '1.1s' }}>
              Every single contribution moves us closer to the {formatKes(FUNDRAISER.targetKes)}{' '}
              goal. Thank you for standing with the family.
            </p>
          </div>
        </section>
      ) : (
        <>
      {/* Hero — open layout, no card */}
      <section id="top" className="border-b border-stone-200 bg-stone-50">
        <div className="mx-auto max-w-5xl px-6 py-12 sm:py-24">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand-600">
            Medical Fundraiser · Kenya
          </p>
          <h1 className="mt-4 max-w-3xl text-4xl font-extrabold leading-[1.1] tracking-tight text-stone-900 sm:text-5xl">
            {FUNDRAISER.title}
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-stone-600">
            {FUNDRAISER.description}
          </p>

          {/* Stats row — open, separated by rules */}
          <div className="mt-12 grid grid-cols-1 gap-y-8 border-t border-stone-200 pt-8 sm:grid-cols-3 sm:divide-x sm:divide-stone-200">
            <div className="sm:pr-10">
              <p className="text-sm font-medium uppercase tracking-wide text-stone-500">
                Raised so far
              </p>
              <p className="mt-1.5 text-3xl font-extrabold tracking-tight text-stone-900">
                {formatKes(raisedKes)}
              </p>
            </div>
            <div className="sm:px-10">
              <p className="text-sm font-medium uppercase tracking-wide text-stone-500">
                Fundraising target
              </p>
              <p className="mt-1.5 text-3xl font-extrabold tracking-tight text-stone-900">
                {formatKes(FUNDRAISER.targetKes)}
              </p>
            </div>
            <div className="sm:pl-10">
              <p className="text-sm font-medium uppercase tracking-wide text-stone-500">Progress</p>
              <p className="mt-1.5 text-3xl font-extrabold tracking-tight text-stone-900">
                {Math.round(progress * 100)}%
              </p>
            </div>
          </div>

          {/* Progress bar */}
          <div className="mt-8 h-2 overflow-hidden rounded-full bg-stone-200">
            <div
              className="h-full min-w-[1.5%] rounded-full bg-brand-700 transition-all duration-700"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
          <p className="mt-3 text-sm text-stone-500">
            {formatKes(remainingKes)} still needed to reach the goal.
          </p>
        </div>
      </section>

      {/* Donation section — two columns on desktop */}
      <main className="mx-auto max-w-5xl px-6 py-16 sm:py-20">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-[420px_1fr] lg:gap-16">
          {/* Info column — below the form on mobile, left on desktop */}
          <section className="order-2 lg:order-1">
            <h2 className="text-2xl font-bold tracking-tight text-stone-900">How it works</h2>
            <ol className="mt-7 space-y-7">
              {[
                {
                  n: '1',
                  title: 'Choose an amount',
                  body: 'Select a preset contribution or enter any amount of KSh 50 and above.',
                },
                {
                  n: '2',
                  title: 'Enter your M-Pesa number',
                  body: 'Use any Safaricom number. We send the payment request directly to your phone.',
                },
                {
                  n: '3',
                  title: 'Approve with your PIN',
                  body: 'An M-Pesa prompt appears on your phone. Enter your PIN to complete the donation.',
                },
              ].map((step) => (
                <li key={step.n} className="flex gap-4">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-stone-300 bg-white text-sm font-bold text-brand-700">
                    {step.n}
                  </span>
                  <div>
                    <p className="font-semibold text-stone-900">{step.title}</p>
                    <p className="mt-1 text-[15px] leading-relaxed text-stone-600">{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>

            <hr className="my-10 border-stone-200" />

            <h2 className="text-2xl font-bold tracking-tight text-stone-900">
              Pay manually instead
            </h2>
            <p className="mt-2 text-[15px] leading-relaxed text-stone-600">
              You can also send money directly via M-Pesa using the details below.
            </p>
            <dl className="mt-6 divide-y divide-stone-200 border-y border-stone-200">
              <div className="flex items-center justify-between py-4">
                <dt className="text-sm font-medium text-stone-500">M-Pesa number</dt>
                <dd className="text-[15px] font-bold text-stone-900">{MANUAL_MPESA.number}</dd>
              </div>
              <div className="flex items-center justify-between py-4">
                <dt className="text-sm font-medium text-stone-500">Account name</dt>
                <dd className="text-[15px] font-bold text-stone-900">{MANUAL_MPESA.name}</dd>
              </div>
            </dl>
            <p className="mt-4 text-xs leading-relaxed text-stone-400">
              Please confirm the recipient details before sending money.
            </p>
          </section>

          {/* Donation panel — right on desktop, first on mobile */}
          <section id="donate" className="order-1 scroll-mt-24 lg:order-2">
            <div className="rounded-2xl border border-stone-200 bg-white p-6 sm:p-7 lg:sticky lg:top-24">
              <h2 className="text-lg font-bold tracking-tight text-stone-900">
                Choose your contribution
              </h2>
              <div className="mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
                {PRESET_AMOUNTS.map((a) => {
                  const selected = customAmount === '' && amount === a;
                  return (
                    <button
                      key={a}
                      type="button"
                      onClick={() => {
                        setCustomAmount('');
                        setAmount(a);
                      }}
                      className={`rounded-lg border py-2.5 text-sm font-semibold transition-colors ${
                        selected
                          ? 'border-brand-900 bg-brand-900 text-white'
                          : 'border-stone-300 bg-white text-stone-700 hover:border-brand-600 hover:text-brand-700'
                      }`}
                    >
                      {a.toLocaleString('en-KE')}
                    </button>
                  );
                })}
              </div>

              <input
                inputMode="numeric"
                placeholder="Other amount (min KSh 50)"
                value={customAmount}
                onChange={(e) => setCustomAmount(e.target.value.replace(/\D/g, '').slice(0, 7))}
                className="mt-3 w-full rounded-lg border border-stone-300 bg-white px-4 py-2.5 text-base outline-none transition-colors placeholder:text-stone-400 focus:border-brand-600 focus:ring-2 focus:ring-brand-600/15"
              />

              {/* Payment method tabs */}
              <div className="mt-5 grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => setMethod('mobile')}
                  className={`flex items-center justify-center gap-2 rounded-lg border py-2.5 text-sm font-semibold transition-colors ${
                    method === 'mobile'
                      ? 'border-brand-900 bg-brand-900 text-white'
                      : 'border-stone-300 bg-white text-stone-700 hover:border-brand-600'
                  }`}
                >
                  Mobile Money
                </button>
                <button
                  type="button"
                  onClick={() => setMethod('card')}
                  className={`flex items-center justify-center gap-2 rounded-lg border py-2.5 text-sm font-semibold transition-colors ${
                    method === 'card'
                      ? 'border-brand-900 bg-brand-900 text-white'
                      : 'border-stone-300 bg-white text-stone-700 hover:border-brand-600'
                  }`}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
                    <rect x="2" y="5" width="20" height="14" rx="2" />
                    <path d="M2 10h20" />
                  </svg>
                  Card
                  <span className={`ml-0.5 flex items-center gap-1 rounded-full px-1.5 py-0.5 ${method === 'card' ? 'bg-white' : 'bg-stone-100'}`}>
                    <img src="/images/visa.svg" alt="Visa" className="h-2.5 w-auto" />
                    <img
                      src="https://upload.wikimedia.org/wikipedia/commons/2/2a/Mastercard-logo.svg"
                      alt="Mastercard"
                      className="h-3 w-auto"
                    />
                  </span>
                </button>
              </div>

              {method === 'mobile' ? (
                <>
                  <label
                    htmlFor="mpesa-phone"
                    className="mb-1.5 mt-5 block text-xs font-bold uppercase tracking-wider text-stone-500"
                  >
                    Phone number — M-Pesa or Airtel Money
                  </label>
                  <div className="relative">
                    <input
                      id="mpesa-phone"
                      inputMode="tel"
                      placeholder="07XX XXX XXX"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value.slice(0, 16))}
                      className="w-full rounded-lg border border-stone-300 bg-white px-4 py-2.5 pr-24 text-base outline-none transition-colors placeholder:text-stone-400 focus:border-brand-600 focus:ring-2 focus:ring-brand-600/15"
                    />
                    {network && (
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-bold uppercase tracking-wide text-brand-700">
                        {network === 'mpesa' ? 'Safaricom' : 'Airtel'}
                      </span>
                    )}
                  </div>

              {method === 'mobile' && (
                <p className="mt-2 text-xs leading-relaxed text-stone-500">
                  We detect your network automatically from the number you enter, then send you a
                  prompt to approve.
                </p>
              )}
                </>
              ) : (
                <p className="mt-4 text-xs leading-relaxed text-stone-500">
                  You will be redirected to Paystack&apos;s secure checkout to enter your Visa or
                  Mastercard details. Your card details never touch this website.
                </p>
              )}

              <button
                type="button"
                onClick={onDonate}
                disabled={busy}
                className="mt-6 flex w-full items-center justify-center gap-2.5 rounded-lg bg-brand-900 py-3.5 text-base font-bold text-white transition-colors hover:bg-brand-700 active:bg-brand-800 disabled:opacity-70"
              >
                {busy ? (
                  spinner
                ) : method === 'card' ? (
                  <>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5" aria-hidden="true">
                      <rect x="2" y="5" width="20" height="14" rx="2" />
                      <path d="M2 10h20" />
                    </svg>
                    Donate with Card
                  </>
                ) : network ? (
                  <>
                    <img
                      src={network === 'mpesa' ? '/images/mpesa.png' : '/images/airtel.png'}
                      alt=""
                      className="h-6 w-auto"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                    Donate with {network === 'mpesa' ? 'M-Pesa' : 'Airtel Money'}
                  </>
                ) : (
                  'Donate Now'
                )}
              </button>

              {(phase === 'error' || phase === 'failed') && statusText !== '' && (
                <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3.5 text-center text-sm leading-relaxed text-red-800">
                  {statusText}
                </div>
              )}
              {phase === 'awaiting-pin' && (
                <div className="mt-4 flex flex-col items-center rounded-lg border border-stone-200 bg-stone-50 p-3.5 text-center">
                  <p className="text-sm leading-relaxed text-stone-700">{statusText}</p>
                  <span className="mt-3 inline-block h-5 w-5 animate-spin rounded-full border-2 border-stone-300 border-t-brand-700" />
                </div>
              )}
              {phase === 'idle' && statusText !== '' && (
                <div className="mt-4 rounded-lg border border-stone-200 bg-stone-50 p-3.5 text-center text-sm leading-relaxed text-stone-700">
                  {statusText}
                </div>
              )}

              <button
                type="button"
                onClick={onShare}
                className="mx-auto mt-4 block text-sm font-semibold text-brand-700 hover:text-brand-900"
              >
                Share this fundraiser
              </button>

              {/* Accepted methods — informational, below the action button */}
              <div className="mt-5 flex items-center justify-center gap-3">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-stone-400">
                  We accept
                </span>
                <span className="flex items-center gap-3 opacity-60">
                  <img src="/images/mpesa.png" alt="M-Pesa" className="h-4 w-auto" />
                  <img src="/images/airtel.png" alt="Airtel Money" className="h-4 w-auto" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                  <img src="/images/visa.svg" alt="Visa" className="h-3 w-auto" />
                  <img
                    src="https://upload.wikimedia.org/wikipedia/commons/2/2a/Mastercard-logo.svg"
                    alt="Mastercard"
                    className="h-3.5 w-auto"
                  />
                </span>
              </div>

              <p className="mt-5 border-t border-stone-100 pt-4 text-center text-xs leading-relaxed text-stone-400">
                Payments are processed securely by Paystack. This page never stores your M-Pesa PIN.
              </p>
            </div>
          </section>
        </div>
      </main>
        </>
      )}

      {/* Footer */}
      <footer className="border-t border-stone-200 bg-stone-50">
        <div className="mx-auto flex max-w-5xl flex-col items-center gap-2 px-6 py-10 text-center">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-900 text-white">
            <CrossMark className="h-3.5 w-3.5" />
          </span>
          <p className="text-sm font-semibold text-stone-700">
            Better Life · Medical Fund for Sylvia&apos;s Mum
          </p>
          <p className="text-xs text-stone-400">Thank you for your support</p>
        </div>
      </footer>
    </div>
  );
}
