// Ad click-ID attribution capture (gclid/fbclid/msclkid) -> sessionStorage,
// read at form submit and pushed into JobTread's Attribution field. Last click wins.
(function(){
  try{
    var p = new URLSearchParams(window.location.search);
    ['gclid','fbclid','msclkid'].forEach(function(k){
      var v = p.get(k);
      if (v) sessionStorage.setItem('ft_attribution', k + '=' + v);
    });
  }catch(e){}
})();

// main.js — Forthright Construction v2

// NAV scroll shadow
const nav = document.getElementById('nav');
if (nav) {
  window.addEventListener('scroll', () => {
    nav.classList.toggle('shadow', window.scrollY > 20);
  }, { passive: true });
}

// Mobile menu
const toggle = document.getElementById('navToggle');
const links = document.getElementById('navLinks');
if (toggle && links) {
  toggle.addEventListener('click', () => {
    const isOpen = links.classList.toggle('open');
    toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    toggle.setAttribute('aria-label', isOpen ? 'Close navigation menu' : 'Open navigation menu');
    // Auto-expand services when menu opens on mobile
    const mega = document.querySelector('.nav-mega');
    const trigger = document.querySelector('.nav-dropdown-trigger');
    if (mega && trigger) {
      if (isOpen) {
        mega.classList.add('open');
        trigger.classList.add('open');
      } else {
        mega.classList.remove('open');
        trigger.classList.remove('open');
      }
    }
  });
  // Close on Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && links.classList.contains('open')) {
      links.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Open navigation menu');
      toggle.focus();
    }
  });
}

// Fade-in on scroll
const observer = new IntersectionObserver(entries => {
  entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); observer.unobserve(e.target); } });
}, { threshold: 0.12 });
document.querySelectorAll('[data-fade]').forEach(el => observer.observe(el));

// Contact form — Google Apps Script submission
const form = document.getElementById('quoteForm');
if (form) {
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('.f-sub');
    btn.textContent = 'Sending...';
    btn.disabled = true;

    try {
      await fetch(form.action, {
        method: 'POST',
        body: new FormData(form),
        mode: 'no-cors'
      });
      form.style.display = 'none';
      document.getElementById('formSuccess').style.display = 'block';
    } catch (err) {
      btn.textContent = 'Something went wrong — please call 802-734-2572';
      btn.style.background = '#b94a48';
      btn.disabled = false;
    }
  });
}

// Mobile services dropdown toggle
const servicesTrigger = document.querySelector('.nav-dropdown-trigger');
const servicesMega = document.querySelector('.nav-mega');
if (servicesTrigger && servicesMega) {
  servicesTrigger.addEventListener('click', function(e) {
    // Only intercept on mobile
    if (window.innerWidth <= 860) {
      e.preventDefault();
      const isOpen = servicesMega.classList.toggle('open');
      servicesTrigger.classList.toggle('open', isOpen);
    }
  });
}

// Desktop mega-menu with linger delay (300ms)
(function() {
  const dropdown = document.querySelector('.nav-dropdown');
  const mega = document.querySelector('.nav-mega');
  if (!dropdown || !mega) return;
  let hideTimer = null;

  function showMega() {
    clearTimeout(hideTimer);
    dropdown.classList.add('mega-open');
  }
  function hideMega() {
    hideTimer = setTimeout(function() {
      dropdown.classList.remove('mega-open');
    }, 300);
  }

  dropdown.addEventListener('mouseenter', showMega);
  dropdown.addEventListener('mouseleave', hideMega);
  mega.addEventListener('mouseenter', showMega);
  mega.addEventListener('mouseleave', hideMega);
})();
