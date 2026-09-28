// Rotating "Edit your match ___" phrase. All phrases live in the markup (so
// they're in the page text); only one is visible and exposed to screen readers.
const phrases = Array.from(document.querySelectorAll('.rotator .phrase'));
const PHRASE_MS = 2400;

let current = 0;

phrases.forEach((p, i) => p.setAttribute('aria-hidden', i === current ? 'false' : 'true'));

function nextPhrase() {
  const outgoing = phrases[current];
  current = (current + 1) % phrases.length;
  const incoming = phrases[current];

  outgoing.classList.remove('is-active');
  outgoing.classList.add('is-leaving');
  outgoing.setAttribute('aria-hidden', 'true');

  incoming.classList.add('is-active');
  incoming.setAttribute('aria-hidden', 'false');

  // Once the leave animation finishes, park the old phrase back below the box
  // without animating, ready for its next turn.
  setTimeout(() => {
    outgoing.style.transition = 'none';
    outgoing.classList.remove('is-leaving');
    outgoing.offsetHeight;
    outgoing.style.transition = '';
  }, 500);
}

if (phrases.length > 1) setInterval(nextPhrase, PHRASE_MS);

// ── Launch transition ──────────────────────────────────────────────────────
// Portrait phone: fade the page, fly the button's phone icon to the centre,
// turn it landscape, clamp controller grips on, then zoom into its white
// screen (the editor is white too, so the page change reads as one motion).
// Desktop / already-landscape: just fade — the turn-your-phone hint means
// nothing there, and nobody should wait on it.
const startBtn = document.querySelector('.start-btn');
const phoneIcon = startBtn.querySelector('.phone-icon .body');
const EASE = 'cubic-bezier(.2,.8,.2,1)';
let launching = false;

const wait = ms => new Promise(r => setTimeout(r, ms));
const rigTransform = (dx, dy, s, deg) =>
  `translate(-50%,-50%) translate(${dx}px,${dy}px) scale(${s}) rotate(${deg}deg)`;

function buildRig(ph) {
  const pw = ph * 0.52;
  const rig = document.createElement('div');
  rig.className = 'launch-rig';
  rig.style.width = pw + 'px';
  rig.style.height = ph + 'px';
  rig.innerHTML = `
    <div class="launch-grip top"><svg viewBox="0 0 24 24"><g fill="#E5484D"><circle cx="16" cy="8" r="4"/></g><g fill="#3E9B4F"><circle cx="8" cy="16" r="4"/></g></svg></div>
    <div class="launch-phone"><div class="launch-screen"><img src="img/icon.png" alt=""></div></div>
    <div class="launch-grip bottom"><svg viewBox="0 0 24 24" class="dpad"><path d="M9 2h6v7h7v6h-7v7H9v-7H2V9h7z"/></svg></div>`;
  const phone = rig.querySelector('.launch-phone');
  const screen = rig.querySelector('.launch-screen');
  const bezel = pw * 0.06;
  phone.style.padding = bezel + 'px';
  phone.style.borderRadius = pw * 0.18 + 'px';
  screen.style.borderRadius = pw * 0.12 + 'px';
  return { rig, pw, bezel };
}

async function phoneLaunch() {
  const iconRect = phoneIcon.getBoundingClientRect();
  // Big enough to read as "a phone", small enough that it still fits once
  // it's sideways with a grip on each end.
  const ph = Math.min(innerHeight * 0.5, innerWidth * 0.55);
  const { rig, pw, bezel } = buildRig(ph);
  document.body.appendChild(rig);
  startBtn.style.visibility = 'hidden';

  const dx = iconRect.left + iconRect.width / 2 - innerWidth / 2;
  const dy = iconRect.top + iconRect.height / 2 - innerHeight / 2;
  const s0 = iconRect.height / ph;
  rig.style.transform = rigTransform(dx, dy, s0, 0);
  const opts = (duration, extra) => ({ duration, easing: EASE, fill: 'forwards', ...extra });

  // 1. Fly to centre and grow
  await rig.animate([
    { transform: rigTransform(dx, dy, s0, 0) },
    { transform: rigTransform(0, 0, 1, 0) },
  ], opts(400)).finished;

  // 2. Turn sideways
  await rig.animate([
    { transform: rigTransform(0, 0, 1, 0) },
    { transform: rigTransform(0, 0, 1, 90) },
  ], opts(420, { easing: 'cubic-bezier(.6,0,.3,1.25)' })).finished;

  // 3. Screen content turns upright (like a real phone) as the grips clamp on
  const logo = rig.querySelector('.launch-screen img');
  logo.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(-90deg)' }], opts(260));
  rig.querySelector('.launch-grip.top').animate(
    [{ opacity: 0, transform: 'translateY(-30%)' }, { opacity: 1, transform: 'translateY(0)' }], opts(260));
  await rig.querySelector('.launch-grip.bottom').animate(
    [{ opacity: 0, transform: 'translateY(30%)' }, { opacity: 1, transform: 'translateY(0)' }], opts(260)).finished;

  await wait(220);

  // 4. Dive into the screen until white covers the viewport
  const screenLong = ph - bezel * 2;
  const screenShort = pw - bezel * 2;
  const cover = Math.max(innerWidth / screenLong, innerHeight / screenShort) * 1.15;
  rig.querySelectorAll('.launch-grip').forEach(g => g.animate([{ opacity: 1 }, { opacity: 0 }], opts(150)));
  logo.animate([{ opacity: 1 }, { opacity: 0 }], opts(150));
  await rig.animate([
    { transform: rigTransform(0, 0, 1, 90) },
    { transform: rigTransform(0, 0, cover, 90) },
  ], opts(320, { easing: 'cubic-bezier(.5,0,.8,.4)' })).finished;
}

startBtn.addEventListener('click', async e => {
  // Let new-tab / new-window clicks behave normally
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  e.preventDefault();
  if (launching) return;
  launching = true;

  const href = startBtn.href;
  const portraitTouch = matchMedia('(pointer: coarse)').matches && innerHeight > innerWidth;
  document.body.classList.add('launching');
  try {
    if (portraitTouch && startBtn.animate) await phoneLaunch();
    else await wait(260);
  } catch (err) {
    // Never let the animation stand between the user and the app
  }
  location.assign(href);
});

// Coming Back from the editor can restore this page from the back/forward
// cache mid-launch — reset it to its resting state.
addEventListener('pageshow', e => {
  if (!e.persisted) return;
  launching = false;
  document.body.classList.remove('launching');
  startBtn.style.visibility = '';
  document.querySelectorAll('.launch-rig').forEach(r => r.remove());
});
