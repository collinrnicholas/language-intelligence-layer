// Labeled detection fixtures for the eligibility policy.
//
// One row per candidate element, labelled by hand from the page it came from.
// `expect.category` is what the row IS; `expect.hard` says it must never reach a
// billable request; `expect.auto` says it may be queued by Check All without the
// user choosing it. Rows with `expect.auto: false` and `expect.hard: false` are
// the ambiguous ones: selectable, never automatic.
//
// The pages are representative shapes, not captures: ecommerce, checkout, SaaS,
// banking, healthcare, education, nonprofit, lead forms and authenticated apps.
// `page` is the signal set scan.js derives from the DOM.

const page = (over = {}) => ({ pageType: 'unknown', ...over });

const SIGNALS = {
  marketingLanding: page({ pageType: 'marketing_landing' }),
  ecommerce: page({ pageType: 'ecommerce' }),
  checkout: page({ pageType: 'checkout' }),
  saasLead: page({ pageType: 'lead_generation' }),
  application: page({ pageType: 'application' }),
  banking: page({ pageType: 'marketing_landing' }),
  healthcare: page({ pageType: 'lead_generation' }),
  education: page({ pageType: 'application' }),
  nonprofit: page({ pageType: 'fundraising' }),
  app: page({ pageType: 'authenticated_app' }),
  content: page({ pageType: 'content' }),
};

const MAIN = { main: true };
const NAV = { nav: true };
const FOOT = { footer: true };
const HERO = { main: true };

const row = (o) => ({
  kind: 'cta',
  tag: 'button',
  landmarks: MAIN,
  aboveFold: true,
  ...o,
});

export const ROWS = [
  // ── Ecommerce ──────────────────────────────────────────────────
  row({ id: 'ec-add-to-cart', vertical: 'ecommerce', page: SIGNALS.ecommerce, text: 'Add to cart',
    hint: 'product-buy-box', landmarks: { main: true, form: true }, expect: { category: 'primary_cta', hard: false, auto: true } }),
  row({ id: 'ec-buy-now', vertical: 'ecommerce', page: SIGNALS.ecommerce, text: 'Buy now — $49',
    hint: 'product-hero cta', expect: { category: 'primary_cta', hard: false, auto: true } }),
  row({ id: 'ec-variant-size', vertical: 'ecommerce', page: SIGNALS.ecommerce, text: 'Size 10',
    hint: 'product-options', landmarks: { main: true, form: true }, expect: { category: 'unknown', hard: false, auto: false } }),
  row({ id: 'ec-sort', vertical: 'ecommerce', page: SIGNALS.ecommerce, text: 'Sort by',
    hint: 'catalog-toolbar', landmarks: { main: true }, expect: { category: 'functional_control', hard: false, auto: false } }),
  row({ id: 'ec-filter', vertical: 'ecommerce', page: SIGNALS.ecommerce, text: 'Apply filters',
    hint: 'catalog-filters', landmarks: { main: true }, expect: { category: 'functional_control', hard: false, auto: false } }),
  row({ id: 'ec-currency', vertical: 'ecommerce', page: SIGNALS.ecommerce, text: 'USD',
    hint: 'currency-picker footer', landmarks: FOOT, expect: { category: 'language', hard: true, auto: false } }),
  row({ id: 'ec-lang', vertical: 'ecommerce', page: SIGNALS.ecommerce, text: 'English (US)',
    hint: 'lang-switcher header', landmarks: { header: true }, expect: { category: 'language', hard: true, auto: false } }),
  row({ id: 'ec-cookie', vertical: 'ecommerce', page: SIGNALS.ecommerce, text: 'Accept all',
    hint: 'onetrust-consent cc-window', landmarks: {}, expect: { category: 'consent', hard: true, auto: false } }),
  row({ id: 'ec-cookie-manage', vertical: 'ecommerce', page: SIGNALS.ecommerce, text: 'Manage preferences',
    hint: 'cookie-banner', landmarks: {}, expect: { category: 'consent', hard: true, auto: false } }),
  row({ id: 'ec-product-headline', vertical: 'ecommerce', kind: 'headline', tag: 'h1',
    page: SIGNALS.ecommerce, text: 'Merino trail socks that last 3 seasons',
    hint: 'product-hero', expect: { category: 'marketing_headline', hard: false, auto: true } }),
  row({ id: 'ec-nav-cart', vertical: 'ecommerce', page: SIGNALS.ecommerce, text: 'Cart',
    hint: 'site-header nav', landmarks: NAV, expect: { category: 'navigation', hard: false, auto: false } }),
  row({ id: 'ec-checkout-pay', vertical: 'ecommerce', page: SIGNALS.checkout, text: 'Pay $128.40',
    hint: 'checkout-actions', landmarks: { main: true, form: true }, expect: { category: 'primary_cta', hard: false, auto: true } }),
  row({ id: 'ec-checkout-back', vertical: 'ecommerce', page: SIGNALS.checkout, text: 'Back',
    hint: 'checkout-stepper', landmarks: { main: true }, expect: { category: 'functional_control', hard: false, auto: false } }),
  row({ id: 'ec-card-field', vertical: 'ecommerce', page: SIGNALS.checkout, text: 'Card number',
    tag: 'label', hint: 'payment-form', landmarks: { main: true, form: true }, inputType: 'text',
    expect: { category: 'sensitive_field', hard: true, auto: false } }),
  row({ id: 'ec-pay-failed', vertical: 'ecommerce', page: SIGNALS.checkout, text: 'Payment failed',
    tag: 'div', kind: 'body', hint: 'checkout-alert', landmarks: { main: true },
    expect: { category: 'system_message', hard: true, auto: false } }),
  row({ id: 'ec-legal', vertical: 'ecommerce', page: SIGNALS.ecommerce, text: 'Terms of service',
    hint: 'legal-links footer', landmarks: FOOT, expect: { category: 'legal', hard: true, auto: false } }),

  // ── SaaS marketing ─────────────────────────────────────────────
  row({ id: 'saas-start-trial', vertical: 'saas', page: SIGNALS.marketingLanding, text: 'Start free trial',
    hint: 'hero cta', expect: { category: 'primary_cta', hard: false, auto: true } }),
  row({ id: 'saas-book-demo', vertical: 'saas', page: SIGNALS.marketingLanding, text: 'Book a demo',
    hint: 'hero-actions', expect: { category: 'primary_cta', hard: false, auto: true } }),
  row({ id: 'saas-pricing', vertical: 'saas', page: SIGNALS.marketingLanding, text: 'See pricing',
    hint: 'pricing-teaser', expect: { category: 'primary_cta', hard: false, auto: true } }),
  row({ id: 'saas-headline', vertical: 'saas', kind: 'headline', tag: 'h1',
    page: SIGNALS.marketingLanding, text: 'Ship onboarding emails 4x faster',
    hint: 'hero', expect: { category: 'marketing_headline', hard: false, auto: true } }),
  row({ id: 'saas-nav-features', vertical: 'saas', page: SIGNALS.marketingLanding, text: 'Features',
    hint: 'site-header nav', landmarks: NAV, expect: { category: 'navigation', hard: false, auto: false } }),
  row({ id: 'saas-login', vertical: 'saas', page: SIGNALS.marketingLanding, text: 'Log in',
    hint: 'site-header nav auth', landmarks: NAV, expect: { category: 'auth_control', hard: true, auto: false } }),
  row({ id: 'saas-search', vertical: 'saas', page: SIGNALS.marketingLanding, text: 'Search',
    hint: 'site-header', landmarks: { header: true }, expect: { category: 'functional_control', hard: false, auto: false } }),
  row({ id: 'saas-chat', vertical: 'saas', page: SIGNALS.marketingLanding, text: 'Chat',
    hint: 'intercom-widget', landmarks: {}, expect: { category: 'functional_control', hard: false, auto: false } }),
  row({ id: 'saas-newsletter', vertical: 'saas', page: SIGNALS.marketingLanding, text: 'Subscribe',
    hint: 'newsletter signup', landmarks: { main: true, form: true }, expect: { category: 'primary_cta', hard: false, auto: true } }),
  row({ id: 'saas-body', vertical: 'saas', kind: 'body', tag: 'p', page: SIGNALS.marketingLanding,
    text: 'Teams cut onboarding time by 40% without adding headcount.',
    hint: 'hero-supporting', landmarks: { main: true }, nearConversion: true,
    expect: { category: 'value_prop', hard: false, auto: true } }),

  // ── Banking / financial ────────────────────────────────────────
  row({ id: 'bank-apply', vertical: 'banking', page: SIGNALS.banking, text: 'Apply now',
    hint: 'hero cta', expect: { category: 'primary_cta', hard: false, auto: true } }),
  row({ id: 'bank-check-rate', vertical: 'banking', page: SIGNALS.banking, text: 'Check your rate in 2 minutes',
    hint: 'rate-widget cta', landmarks: { main: true, form: true }, expect: { category: 'primary_cta', hard: false, auto: true } }),
  row({ id: 'bank-apr-headline', vertical: 'banking', kind: 'headline', tag: 'h1',
    page: SIGNALS.banking, text: 'Refinance and save $284 a month',
    hint: 'hero', expect: { category: 'marketing_headline', hard: false, auto: true } }),
  row({ id: 'bank-disclosure', vertical: 'banking', kind: 'body', tag: 'p', page: SIGNALS.banking,
    text: 'Subject to credit approval. Rates and terms vary by state.',
    hint: 'disclosure legal', landmarks: { main: true }, expect: { category: 'legal', hard: true, auto: false } }),
  row({ id: 'bank-equal-housing', vertical: 'banking', text: 'Equal Housing Opportunity',
    hint: 'site-footer legal', landmarks: FOOT, expect: { category: 'legal', hard: true, auto: false } }),
  row({ id: 'bank-ssn', vertical: 'banking', text: 'Social Security Number',
    tag: 'label', hint: 'application-form', landmarks: { main: true, form: true },
    expect: { category: 'sensitive_field', hard: true, auto: false } }),
  row({ id: 'bank-verify', vertical: 'banking', text: 'Verify your identity',
    hint: 'account-security', landmarks: { main: true }, expect: { category: 'auth_control', hard: true, auto: false } }),
  row({ id: 'bank-captcha', vertical: 'banking', text: "I'm not a robot",
    hint: 'recaptcha', landmarks: { form: true }, expect: { category: 'security_check', hard: true, auto: false } }),

  // ── Healthcare ─────────────────────────────────────────────────
  row({ id: 'health-book', vertical: 'healthcare', page: SIGNALS.healthcare, text: 'Book an appointment',
    hint: 'hero cta', expect: { category: 'primary_cta', hard: false, auto: true } }),
  row({ id: 'health-headline', vertical: 'healthcare', kind: 'headline', tag: 'h1',
    page: SIGNALS.healthcare, text: 'Same-day care, 7 days a week',
    hint: 'hero', expect: { category: 'marketing_headline', hard: false, auto: true } }),
  row({ id: 'health-hipaa', vertical: 'healthcare', kind: 'body', tag: 'p', page: SIGNALS.healthcare,
    text: 'This notice describes how medical information about you may be used and disclosed.',
    hint: 'hipaa privacy notice', landmarks: { main: true }, expect: { category: 'legal', hard: true, auto: false } }),
  row({ id: 'health-patient-portal', vertical: 'healthcare', text: 'Patient portal log in',
    hint: 'site-header nav', landmarks: NAV, expect: { category: 'auth_control', hard: true, auto: false } }),
  row({ id: 'health-dob', vertical: 'healthcare', text: 'Date of birth',
    tag: 'label', hint: 'intake-form', landmarks: { form: true }, expect: { category: 'sensitive_field', hard: true, auto: false } }),

  // ── Education ──────────────────────────────────────────────────
  row({ id: 'edu-apply', vertical: 'education', page: SIGNALS.application, text: 'Start your application',
    hint: 'apply-hero cta', expect: { category: 'primary_cta', hard: false, auto: true } }),
  row({ id: 'edu-apply-now', vertical: 'education', page: SIGNALS.application, text: 'Apply now',
    hint: 'apply-hero', expect: { category: 'primary_cta', hard: false, auto: true } }),
  row({ id: 'edu-deadline', vertical: 'education', kind: 'headline', tag: 'h1', page: SIGNALS.application,
    text: 'Apply for fall 2027 by January 15',
    hint: 'apply-hero', expect: { category: 'marketing_headline', hard: false, auto: true } }),
  row({ id: 'edu-nav-admissions', vertical: 'education', page: SIGNALS.application, text: 'Admissions',
    hint: 'site-header nav', landmarks: NAV, expect: { category: 'navigation', hard: false, auto: false } }),
  row({ id: 'edu-a11y', vertical: 'education', text: 'Accessibility statement',
    hint: 'site-footer', landmarks: FOOT, expect: { category: 'accessibility', hard: true, auto: false } }),
  row({ id: 'edu-tuition-terms', vertical: 'education', kind: 'body', tag: 'p', page: SIGNALS.application,
    text: 'By accepting admission you agree to the terms and conditions and the refund policy.',
    hint: 'legal', landmarks: { main: true }, expect: { category: 'legal', hard: true, auto: false } }),

  // ── Nonprofit ──────────────────────────────────────────────────
  row({ id: 'np-donate', vertical: 'nonprofit', page: SIGNALS.nonprofit, text: 'Donate now',
    hint: 'hero cta', expect: { category: 'primary_cta', hard: false, auto: true } }),
  row({ id: 'np-give-monthly', vertical: 'nonprofit', page: SIGNALS.nonprofit, text: 'Give monthly — $10 feeds a family for a week',
    hint: 'donation-module cta', landmarks: { main: true, form: true }, expect: { category: 'primary_cta', hard: false, auto: true } }),
  row({ id: 'np-headline', vertical: 'nonprofit', kind: 'headline', tag: 'h1', page: SIGNALS.nonprofit,
    text: 'Your $25 becomes 100 meals this winter',
    hint: 'hero', expect: { category: 'marketing_headline', hard: false, auto: true } }),
  row({ id: 'np-unsubscribe', vertical: 'nonprofit', text: 'Unsubscribe',
    hint: 'email-footer legal', landmarks: FOOT, expect: { category: 'legal', hard: true, auto: false } }),

  // ── Lead generation ────────────────────────────────────────────
  row({ id: 'lead-request-quote', vertical: 'saas', page: SIGNALS.saasLead, text: 'Request a quote',
    hint: 'lead-form cta', landmarks: { main: true, form: true }, expect: { category: 'primary_cta', hard: false, auto: true } }),
  row({ id: 'lead-email-label', vertical: 'saas', page: SIGNALS.saasLead, text: 'Work email',
    tag: 'label', hint: 'lead-form', landmarks: { form: true }, inputType: 'email',
    expect: { category: 'unknown', hard: false, auto: false } }),
  row({ id: 'lead-submit', vertical: 'saas', page: SIGNALS.saasLead, text: 'Get my quote',
    hint: 'lead-form', landmarks: { main: true, form: true }, expect: { category: 'primary_cta', hard: false, auto: true } }),
  row({ id: 'lead-consent', vertical: 'saas', page: SIGNALS.saasLead, text: 'I agree to receive marketing emails',
    tag: 'label', hint: 'lead-form consent', landmarks: { form: true },
    expect: { category: 'consent', hard: true, auto: false } }),

  // ── Authenticated application (ChatGPT-shaped shell) ───────────
  row({ id: 'app-new-chat', vertical: 'app', page: SIGNALS.app, text: 'New chat',
    hint: 'app-sidebar', landmarks: { nav: true, aside: true }, expect: { category: 'navigation', hard: false, auto: false } }),
  row({ id: 'app-projects', vertical: 'app', page: SIGNALS.app, text: 'Projects',
    hint: 'sidebar nav', landmarks: NAV, expect: { category: 'navigation', hard: false, auto: false } }),
  row({ id: 'app-spaces', vertical: 'app', page: SIGNALS.app, text: 'Space',
    hint: 'sidebar nav', landmarks: NAV, expect: { category: 'navigation', hard: false, auto: false } }),
  row({ id: 'app-explore', vertical: 'app', page: SIGNALS.app, text: 'Explore',
    hint: 'sidebar nav', landmarks: NAV, expect: { category: 'navigation', hard: false, auto: false } }),
  row({ id: 'app-settings', vertical: 'app', page: SIGNALS.app, text: 'Settings',
    hint: 'sidebar nav', landmarks: NAV, expect: { category: 'functional_control', hard: false, auto: false } }),
  row({ id: 'app-upgrade', vertical: 'app', page: SIGNALS.app, text: 'Upgrade to Plus',
    hint: 'sidebar upsell', landmarks: { nav: true, aside: true }, expect: { category: 'secondary_cta', hard: false, auto: true } }),
  row({ id: 'app-help', vertical: 'app', page: SIGNALS.app, text: 'Help',
    hint: 'sidebar nav', landmarks: NAV, expect: { category: 'functional_control', hard: false, auto: false } }),
  row({ id: 'app-send', vertical: 'app', page: SIGNALS.app, text: 'Send message',
    hint: 'composer', landmarks: { main: true, form: true }, expect: { category: 'functional_control', hard: false, auto: false } }),
  row({ id: 'app-modal-close', vertical: 'app', page: SIGNALS.app, text: 'Close',
    hint: 'dialog', landmarks: { dialog: true }, expect: { category: 'functional_control', hard: false, auto: false } }),

  // ── Content site ───────────────────────────────────────────────
  row({ id: 'content-subscribe', vertical: 'content', page: SIGNALS.content, text: 'Subscribe for $5 a month',
    hint: 'paywall cta', landmarks: { main: true }, expect: { category: 'primary_cta', hard: false, auto: true } }),
  row({ id: 'content-headline', vertical: 'content', kind: 'headline', tag: 'h1', page: SIGNALS.content,
    text: 'Why the housing market cooled in 2026',
    hint: 'article', landmarks: { main: true }, expect: { category: 'unknown', hard: false, auto: false } }),
  row({ id: 'content-skip', vertical: 'content', text: 'Skip to content',
    hint: 'skip-link', landmarks: {}, expect: { category: 'accessibility', hard: true, auto: false } }),

  // ── Cross-cutting regressions ──────────────────────────────────
  row({ id: 'x-es-en', vertical: 'ecommerce', text: 'EN / ES',
    hint: 'header', landmarks: { header: true }, expect: { category: 'language', hard: true, auto: false } }),
  row({ id: 'x-espanol', vertical: 'education', text: 'Español',
    hint: 'header utility', landmarks: { header: true }, expect: { category: 'language', hard: true, auto: false } }),
  row({ id: 'x-choose-language', vertical: 'saas', text: 'Choose your language',
    hint: 'header', landmarks: { header: true }, expect: { category: 'language', hard: true, auto: false } }),
  row({ id: 'x-reject-all', vertical: 'healthcare', text: 'Reject all',
    hint: 'cc-banner', landmarks: {}, expect: { category: 'consent', hard: true, auto: false } }),
  row({ id: 'x-got-it', vertical: 'content', text: 'Got it',
    hint: 'cookie-notice', landmarks: {}, expect: { category: 'consent', hard: true, auto: false } }),
  row({ id: 'x-free-trial', vertical: 'saas', page: SIGNALS.marketingLanding, text: 'Try free for 14 days',
    hint: 'pricing-card cta', expect: { category: 'primary_cta', hard: false, auto: true } }),
  row({ id: 'x-generic-learn-more', vertical: 'saas', page: SIGNALS.marketingLanding, text: 'Learn more',
    hint: 'feature-card link', landmarks: { main: true }, expect: { category: 'unknown', hard: false, auto: false } }),
  row({ id: 'x-copyright', vertical: 'ecommerce', kind: 'body', tag: 'p', page: SIGNALS.ecommerce,
    text: '© 2026 Northwind Supply Co. All rights reserved.',
    hint: 'site-footer', landmarks: FOOT, expect: { category: 'legal', hard: true, auto: false } }),
  row({ id: 'x-session-expired', vertical: 'app', text: 'Session expired',
    tag: 'div', kind: 'body', hint: 'app-toast alert', landmarks: { main: true },
    expect: { category: 'system_message', hard: true, auto: false } }),
];

/** Cases where the classifier must not be confidently wrong: report these. */
export const AMBIGUOUS = ROWS.filter((r) => !r.expect.hard && !r.expect.auto).map((r) => r.id);

/** Primary conversion actions, for the CTA-identification accuracy metric. */
export const PRIMARY_CTA_IDS = ROWS.filter((r) => r.expect.category === 'primary_cta').map((r) => r.id);

// ── Held-out rows ────────────────────────────────────────────────
// Written after the rules were tuned, to see how the policy behaves on wording
// it was not built against. These are reported separately and are NOT used to
// tune thresholds: where the policy is uncertain it should say so.
export const HOLDOUT = [
  row({ id: 'h-0-apr', vertical: 'banking', kind: 'headline', tag: 'h1', page: SIGNALS.banking,
    text: 'Get 0% APR for 18 months on balance transfers', hint: 'hero',
    expect: { category: 'marketing_headline', hard: false, auto: true } }),
  row({ id: 'h-privacy-link', vertical: 'content', text: 'Read our privacy policy',
    hint: 'article-footer', landmarks: FOOT, expect: { category: 'legal', hard: true, auto: false } }),
  row({ id: 'h-continue-google', vertical: 'saas', text: 'Continue with Google',
    hint: 'auth-dialog', landmarks: { dialog: true }, expect: { category: 'auth_control', hard: true, auto: false } }),
  row({ id: 'h-signup-google', vertical: 'saas', page: SIGNALS.marketingLanding, text: 'Sign up with Google',
    hint: 'hero signup', expect: { category: 'primary_cta', hard: false, auto: true } }),
  row({ id: 'h-add-to-bag', vertical: 'ecommerce', page: SIGNALS.ecommerce, text: 'Add to bag',
    hint: 'product-buy', landmarks: { main: true, form: true }, expect: { category: 'primary_cta', hard: false, auto: true } }),
  row({ id: 'h-join-readers', vertical: 'content', page: SIGNALS.content, text: 'Join 40,000 readers',
    hint: 'newsletter', landmarks: { main: true, form: true }, expect: { category: 'primary_cta', hard: false, auto: true } }),
  row({ id: 'h-donate-50', vertical: 'nonprofit', page: SIGNALS.nonprofit, text: 'Donate $50',
    hint: 'donation-form', landmarks: { main: true, form: true }, expect: { category: 'primary_cta', hard: false, auto: true } }),
  row({ id: 'h-free-quote', vertical: 'saas', page: SIGNALS.saasLead, text: 'Request your free quote',
    hint: 'hero form', landmarks: { main: true, form: true }, expect: { category: 'primary_cta', hard: false, auto: true } }),
  row({ id: 'h-chat-sales', vertical: 'saas', page: SIGNALS.marketingLanding, text: 'Chat with sales',
    hint: 'hero-actions', expect: { category: 'primary_cta', hard: false, auto: true } }),
  row({ id: 'h-download-report', vertical: 'saas', page: SIGNALS.marketingLanding, text: 'Download the 2026 benchmark report',
    hint: 'gated-content cta', expect: { category: 'primary_cta', hard: false, auto: true } }),
  row({ id: 'h-cookie-settings', vertical: 'education', text: 'Cookie settings',
    hint: 'site-footer', landmarks: FOOT, expect: { category: 'consent', hard: true, auto: false } }),
  row({ id: 'h-skip-main', vertical: 'content', text: 'Skip to main content',
    hint: 'skip-link', landmarks: {}, expect: { category: 'accessibility', hard: true, auto: false } }),
  row({ id: 'h-verify-email', vertical: 'app', text: 'Verify your email',
    hint: 'account-banner', landmarks: { main: true }, expect: { category: 'auth_control', hard: true, auto: false } }),
  row({ id: 'h-passkey', vertical: 'app', text: 'Use a passkey',
    hint: 'auth-modal', landmarks: { dialog: true }, expect: { category: 'auth_control', hard: true, auto: false } }),
  row({ id: 'h-pay-now', vertical: 'ecommerce', page: SIGNALS.checkout, text: 'Pay now',
    hint: 'checkout-summary', landmarks: { main: true, form: true }, expect: { category: 'primary_cta', hard: false, auto: true } }),
  row({ id: 'h-view-cart', vertical: 'ecommerce', page: SIGNALS.ecommerce, text: 'View cart',
    hint: 'site-header nav', landmarks: NAV, expect: { category: 'navigation', hard: false, auto: false } }),
  row({ id: 'h-show-more', vertical: 'content', page: SIGNALS.content, text: 'Show more',
    hint: 'article-list', landmarks: { main: true }, expect: { category: 'functional_control', hard: false, auto: false } }),
  row({ id: 'h-start-application', vertical: 'education', page: SIGNALS.application, text: 'Start application',
    hint: 'apply-hero', expect: { category: 'primary_cta', hard: false, auto: true } }),
  row({ id: 'h-book-call', vertical: 'saas', page: SIGNALS.marketingLanding, text: 'Book a call',
    hint: 'hero-actions', expect: { category: 'primary_cta', hard: false, auto: true } }),
  row({ id: 'h-get-started', vertical: 'saas', page: SIGNALS.marketingLanding, text: 'Get started',
    hint: 'hero-actions', expect: { category: 'primary_cta', hard: false, auto: true } }),
  row({ id: 'h-manage-prefs', vertical: 'ecommerce', text: 'Manage cookie preferences',
    hint: 'consent-manager', landmarks: {}, expect: { category: 'consent', hard: true, auto: false } }),
  row({ id: 'h-new-project', vertical: 'app', page: SIGNALS.app, text: 'New project',
    hint: 'app-sidebar', landmarks: NAV, expect: { category: 'navigation', hard: false, auto: false } }),
  row({ id: 'h-templates', vertical: 'app', page: SIGNALS.app, text: 'Templates',
    hint: 'app-sidebar', landmarks: NAV, expect: { category: 'navigation', hard: false, auto: false } }),
  row({ id: 'h-billing', vertical: 'app', page: SIGNALS.app, text: 'Billing',
    hint: 'sidebar nav', landmarks: NAV, expect: { category: 'functional_control', hard: false, auto: false } }),
  row({ id: 'h-find-doctor', vertical: 'healthcare', page: SIGNALS.healthcare, text: 'Find a doctor',
    hint: 'hero cta', expect: { category: 'primary_cta', hard: false, auto: true } }),
];
