import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';
await load('page-noise.js');
const N = globalThis.PERSADO_NOISE;
const noise = (text, extra = {}) => N.isNoise({ text, kind: 'cta', ...extra });

test('consent furniture is never a call to action', () => {
  for (const s of ['Cookie settings', 'Accept all', 'Reject all', 'Manage preferences',
    'Privacy Policy', 'Terms of Use', 'Do not sell or share my personal information',
    'Got it', 'Allow', 'Your privacy choices', 'Cookie consent']) {
    assert.equal(noise(s), true, s);
  }
});

test('language and locale switchers are not calls to action', () => {
  for (const s of ['English', 'Español', 'EN/ES', 'Français', 'Deutsch', '日本語',
    'Tiếng Việt', 'English (US)', 'Change language', 'Select language']) {
    assert.equal(noise(s), true, s);
  }
});

test('site utilities and widgets are not calls to action', () => {
  for (const s of ['Skip to content', 'Back to top', 'Search', 'Close', 'Log in',
    'Sign in', 'My account', 'Cart', 'Share on Facebook', 'Copy link', 'Powered by Webflow',
    'USD', 'Country', 'Choose your region']) {
    assert.equal(noise(s), true, s);
  }
});

test('real marketing CTAs survive', () => {
  for (const s of ['Request program information', 'Apply now', 'Book a call',
    'Start your free trial', 'Get pricing', 'Talk to sales', 'Download the guide',
    'Accept payments online', 'Join the waitlist', 'See how it works', 'Enrol your child',
    'Spanish immersion program for grades K-8']) {
    assert.equal(N.isNoise({ text: s, kind: 'cta', hint: 'main content hero' }), false, s);
  }
});

test('a cookie banner or chat widget poisons everything inside it', () => {
  assert.equal(noise('Continue', { hint: 'div id=onetrust-consent-sdk' }), true);
  assert.equal(noise('Continue', { hint: 'div class=CookieBanner__root' }), true);
  assert.equal(noise('Talk to us', { hint: 'div id=intercom-container' }), true);
  assert.equal(noise('English', { hint: 'div class=lang-switch' }), true);
  assert.equal(noise('Get a demo', { hint: 'section class=hero' }), false);
});

test('form controls are controls, not copy', () => {
  assert.equal(noise('Choose a pathway', { control: true }), true);
});

test('headlines keep their place unless they sit in widget furniture', () => {
  assert.equal(N.isNoise({ text: 'Privacy, without the fine print', kind: 'headline', hint: 'h1' }), false);
  assert.equal(N.isNoise({ text: 'We value your privacy', kind: 'headline', hint: 'div class=cc-window' }), true);
});
