/* ================================================
   HOUSE OF MANGALYA — Main JavaScript
   Full cart system + all page interactions
   ================================================ */

// ── PRODUCT DISPLAY DATA ───────────────────────────
// Display only. The server (server/catalog.js) is the source of truth for prices.
const PRODUCTS = {
  'turmeric-1kg': {
    id:    'turmeric-1kg',
    name:  'Single-Origin Turmeric Powder',
    weight:'1 kg',
    price: 500,
    img:   'assets/product.jpg'
  }
};
const MAX_QTY = 20;

// ── CART STORE (localStorage) ──────────────────────
// Only {id, qty} is stored. Anything else in storage is ignored, so a tampered
// cart can't inject markup or change prices.
const Cart = {
  get() {
    let raw;
    try {
      raw = JSON.parse(localStorage.getItem('hom_cart') || '[]');
    } catch {
      raw = [];
    }
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(i => i && Object.hasOwn(PRODUCTS, i.id) && Number.isInteger(i.qty) && i.qty > 0)
      .map(i => ({ id: i.id, qty: Math.min(i.qty, MAX_QTY) }));
  },
  save(items) {
    try {
      localStorage.setItem('hom_cart', JSON.stringify(items.map(({ id, qty }) => ({ id, qty }))));
    } catch { /* storage full or blocked — cart lives for this page only */ }
    Cart.updateBadge();
    Cart.renderDrawer();
    document.dispatchEvent(new CustomEvent('cart:change'));
  },
  clear() {
    Cart.save([]);
  },
  add(product, qty = 1) {
    const items = Cart.get();
    const existing = items.find(i => i.id === product.id);
    if (existing) {
      existing.qty = Math.min(existing.qty + qty, MAX_QTY);
    } else {
      items.push({ id: product.id, qty: Math.min(qty, MAX_QTY) });
    }
    Cart.save(items);
    Cart.showToast(`✦ ${product.name} added to cart!`);
    Cart.openDrawer();
  },
  remove(id) {
    const items = Cart.get().filter(i => i.id !== id);
    Cart.save(items);
  },
  updateQty(id, delta) {
    const items = Cart.get();
    const item = items.find(i => i.id === id);
    if (item) {
      item.qty = Math.min(MAX_QTY, Math.max(1, item.qty + delta));
      Cart.save(items);
    }
  },
  total() {
    return Cart.get().reduce((sum, i) => sum + PRODUCTS[i.id].price * i.qty, 0);
  },
  count() {
    return Cart.get().reduce((sum, i) => sum + i.qty, 0);
  },
  updateBadge() {
    const cnt = Cart.count();
    document.querySelectorAll('.cart-badge').forEach(badge => {
      badge.textContent = cnt;
      badge.style.display = cnt > 0 ? 'flex' : 'none';
    });
  },
  openDrawer() {
    document.getElementById('cart-drawer')?.classList.add('open');
    document.getElementById('cart-overlay')?.classList.add('show');
    document.body.style.overflow = 'hidden';
  },
  closeDrawer() {
    document.getElementById('cart-drawer')?.classList.remove('open');
    document.getElementById('cart-overlay')?.classList.remove('show');
    document.body.style.overflow = '';
  },
  renderDrawer() {
    const list = document.getElementById('cart-items-list');
    const totalEl = document.getElementById('cart-total-price');
    const emptyEl = document.getElementById('cart-empty');
    const footerEl = document.getElementById('cart-footer');
    if (!list) return;

    const items = Cart.get();
    list.replaceChildren();

    if (items.length === 0) {
      emptyEl && (emptyEl.style.display = 'block');
      footerEl && (footerEl.style.display = 'none');
      return;
    }

    emptyEl && (emptyEl.style.display = 'none');
    footerEl && (footerEl.style.display = 'block');

    // Built with DOM APIs + textContent — never innerHTML with data
    const h = (tag, cls, text) => {
      const el = document.createElement(tag);
      if (cls) el.className = cls;
      if (text !== undefined) el.textContent = text;
      return el;
    };

    items.forEach(item => {
      const p = PRODUCTS[item.id];
      const row = h('div', 'cart-item');

      const img = h('img', 'cart-item-img');
      img.src = p.img;
      img.alt = p.name;

      const minus = h('button', 'cart-qty-btn', '−');
      minus.setAttribute('aria-label', 'Decrease quantity');
      minus.addEventListener('click', () => Cart.updateQty(item.id, -1));
      const plus = h('button', 'cart-qty-btn', '+');
      plus.setAttribute('aria-label', 'Increase quantity');
      plus.addEventListener('click', () => Cart.updateQty(item.id, 1));
      const ctrl = h('div', 'cart-qty-ctrl');
      ctrl.append(minus, h('span', '', String(item.qty)), plus);

      const ctrlRow = h('div', 'cart-item-row');
      ctrlRow.append(ctrl, h('span', 'cart-item-price', `₹${(p.price * item.qty).toLocaleString('en-IN')}`));

      const info = h('div', 'cart-item-info');
      info.append(h('p', 'cart-item-name', p.name), h('p', 'cart-item-sub', p.weight), ctrlRow);

      const removeBtn = h('button', 'cart-remove-btn', '✕');
      removeBtn.setAttribute('aria-label', `Remove ${p.name}`);
      removeBtn.addEventListener('click', () => Cart.remove(item.id));

      row.append(img, info, removeBtn);
      list.appendChild(row);
    });

    if (totalEl) totalEl.textContent = `₹${Cart.total().toLocaleString('en-IN')}`;
  },
  showToast(msg) {
    let toast = document.getElementById('cart-toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(Cart._toastTimer);
    Cart._toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
  }
};

// ── ATTRIBUTION (where did this visitor come from?) ─
// Stores only a short channel label (utm_* params or the referring site's hostname) for 30 days,
// and sends it with the order so the owner can see which channels make money. No personal data.
const Attribution = {
  key: 'hom_attr',
  capture() {
    try {
      const p = new URLSearchParams(location.search);
      const source = p.get('utm_source');
      let referrer = '';
      if (document.referrer) {
        const host = new URL(document.referrer).hostname.replace(/^www\./, '');
        if (host && host !== location.hostname) referrer = host;
      }
      const current = JSON.parse(localStorage.getItem(Attribution.key) || 'null');
      const expired = !current || Date.now() - current.at > 30 * 864e5;
      // A tagged link always wins (last campaign touch); otherwise keep the first touch for 30 days
      if (source || expired) {
        localStorage.setItem(Attribution.key, JSON.stringify({
          source: source || null, medium: p.get('utm_medium'), campaign: p.get('utm_campaign'), referrer, at: Date.now()
        }));
      }
    } catch { /* storage blocked */ }
  },
  get() {
    try {
      const v = JSON.parse(localStorage.getItem(Attribution.key) || 'null');
      if (!v || Date.now() - v.at > 30 * 864e5) return {};
      return { source: v.source, medium: v.medium, campaign: v.campaign, referrer: v.referrer };
    } catch { return {}; }
  }
};
Attribution.capture();

// ── BUILD CART UI (injected into every page) ────────
function buildCartUI() {
  // Toast
  const toast = document.createElement('div');
  toast.id = 'cart-toast';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  document.body.appendChild(toast);

  // Overlay
  const overlay = document.createElement('div');
  overlay.id = 'cart-overlay';
  overlay.addEventListener('click', Cart.closeDrawer);
  document.body.appendChild(overlay);

  // Drawer
  const drawer = document.createElement('div');
  drawer.id = 'cart-drawer';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-label', 'Shopping cart');
  drawer.innerHTML = `
    <div class="cart-drawer-header">
      <h3>Your Cart</h3>
      <button id="cart-close-btn" aria-label="Close cart">✕</button>
    </div>
    <div id="cart-empty" class="cart-empty">
      <span>🛒</span>
      <p>Your cart is empty</p>
      <a href="product.html" class="btn btn-primary" style="margin-top:1rem;font-size:0.75rem;">Shop Now</a>
    </div>
    <div id="cart-items-list" class="cart-items-list"></div>
    <div id="cart-footer" class="cart-footer" style="display:none;">
      <div class="cart-subtotal">
        <span>Subtotal</span>
        <span id="cart-total-price">₹0</span>
      </div>
      <p class="cart-shipping-note">🚚 Free shipping above ₹999</p>
      <button class="btn btn-primary" style="width:100%;justify-content:center;" id="checkout-btn">
        Proceed to Checkout →
      </button>
      <a href="product.html" class="cart-continue">← Continue Shopping</a>
    </div>
  `;
  document.body.appendChild(drawer);

  document.getElementById('cart-close-btn').addEventListener('click', Cart.closeDrawer);
  document.getElementById('checkout-btn')?.addEventListener('click', () => {
    window.location.href = 'checkout.html';
  });
}

// ── INJECT CART ICON INTO NAVBAR ────────────────────
function injectCartIcon() {
  const navActions = document.querySelector('.nav-actions');
  if (!navActions) return;

  const cartBtn = document.createElement('button');
  cartBtn.id = 'cart-icon-btn';
  cartBtn.className = 'cart-icon-btn';
  cartBtn.setAttribute('aria-label', 'Open shopping cart');
  cartBtn.innerHTML = `
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/>
      <line x1="3" y1="6" x2="21" y2="6"/>
      <path d="M16 10a4 4 0 01-8 0"/>
    </svg>
    <span class="cart-badge" style="display:none;">0</span>
  `;
  cartBtn.addEventListener('click', () => {
    Cart.renderDrawer();
    Cart.openDrawer();
  });
  navActions.insertBefore(cartBtn, navActions.firstChild);
}

document.addEventListener('DOMContentLoaded', () => {

  // Build cart system
  buildCartUI();
  injectCartIcon();
  Cart.updateBadge();
  Cart.renderDrawer();

  // ── Navbar Scroll Behavior ─────────────────────
  const navbar = document.querySelector('.navbar');
  const handleScroll = () => {
    if (window.scrollY > 60) navbar?.classList.add('scrolled');
    else navbar?.classList.remove('scrolled');
  };
  window.addEventListener('scroll', handleScroll, { passive: true });
  handleScroll();

  // ── Mobile Menu ────────────────────────────────
  const hamburger = document.querySelector('.hamburger');
  const navLinks  = document.querySelector('.nav-links');
  hamburger?.addEventListener('click', () => {
    navLinks?.classList.toggle('open');
    const isOpen = navLinks?.classList.contains('open');
    hamburger.setAttribute('aria-expanded', isOpen);
    const spans = hamburger.querySelectorAll('span');
    if (isOpen) {
      spans[0].style.transform = 'rotate(45deg) translate(5px, 5px)';
      spans[1].style.opacity   = '0';
      spans[2].style.transform = 'rotate(-45deg) translate(5px, -5px)';
    } else {
      spans[0].style.transform = spans[1].style.opacity = spans[2].style.transform = '';
    }
  });
  document.querySelectorAll('.nav-links a').forEach(link => {
    link.addEventListener('click', () => {
      navLinks?.classList.remove('open');
      const spans = hamburger?.querySelectorAll('span');
      if (spans) spans[0].style.transform = spans[1].style.opacity = spans[2].style.transform = '';
    });
  });

  // ── Active Nav Link ────────────────────────────
  const currentPage = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-links a').forEach(link => {
    const href = link.getAttribute('href');
    if (href === currentPage || (currentPage === '' && href === 'index.html')) {
      link.classList.add('active');
    }
  });

  // ── Scroll Fade-In Animations ──────────────────
  const fadeEls = document.querySelectorAll('.fade-in');
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        const siblings = [...(entry.target.parentElement?.children ?? [])];
        const idx = siblings.indexOf(entry.target);
        setTimeout(() => entry.target.classList.add('visible'), idx * 80);
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });
  fadeEls.forEach(el => observer.observe(el));

  // ── FAQ Accordion ──────────────────────────────
  document.querySelectorAll('.faq-question').forEach(btn => {
    btn.addEventListener('click', () => {
      const item   = btn.closest('.faq-item');
      const isOpen = item.classList.contains('open');
      document.querySelectorAll('.faq-item.open').forEach(el => el.classList.remove('open'));
      if (!isOpen) item.classList.add('open');
    });
  });

  // ── FAQ Category Filter ────────────────────────
  document.querySelectorAll('.faq-cat-link').forEach(link => {
    link.addEventListener('click', () => {
      document.querySelectorAll('.faq-cat-link').forEach(l => l.classList.remove('active'));
      link.classList.add('active');
      const target = link.dataset.target;
      document.querySelectorAll('.faq-group').forEach(g => {
        g.style.display = (target === 'all' || g.id === target) ? '' : 'none';
      });
    });
  });

  // ── Quantity Selector (Product Page) ──────────
  const qtyNum = document.querySelector('.qty-num');
  document.querySelector('.qty-minus')?.addEventListener('click', () => {
    const curr = parseInt(qtyNum.textContent);
    if (curr > 1) qtyNum.textContent = curr - 1;
  });
  document.querySelector('.qty-plus')?.addEventListener('click', () => {
    const curr = parseInt(qtyNum.textContent);
    if (curr < MAX_QTY) qtyNum.textContent = curr + 1;
  });

  // ── ADD TO CART (Product Page) ─────────────────
  const addToCartBtn = document.querySelector('#add-to-cart-btn');
  if (addToCartBtn) {
    let outOfStock = false;
    addToCartBtn.addEventListener('click', () => {
      if (outOfStock) return;
      const qty = parseInt(document.querySelector('.qty-num')?.textContent || '1');
      Cart.add(PRODUCTS['turmeric-1kg'], qty);

      // Button feedback
      const orig = addToCartBtn.innerHTML;
      addToCartBtn.innerHTML = '✓ Added to Cart!';
      addToCartBtn.style.background = 'linear-gradient(135deg, #3B5E3A, #2d4a2c)';
      addToCartBtn.disabled = true;
      setTimeout(() => {
        addToCartBtn.innerHTML = orig;
        addToCartBtn.style.background = '';
        addToCartBtn.disabled = outOfStock;
      }, 2000);
    });

    // Live stock: "Only 7 left" / "Out of stock" (silently skipped if the API isn't reachable)
    fetch('/api/config').then(r => (r.ok ? r.json() : null)).then(cfg => {
      const p = cfg?.products?.find(x => x.id === 'turmeric-1kg');
      const note = document.getElementById('stock-note');
      if (!p || !note) return;
      note.hidden = false;
      if (p.stockStatus === 'out') {
        outOfStock = true;
        addToCartBtn.disabled = true;
        addToCartBtn.textContent = 'Out of stock';
        note.textContent = 'Currently out of stock — back soon.';
        note.className = 'stock-note stock-out';
      } else if (p.stockStatus === 'low') {
        note.textContent = `Only ${p.left} left — order soon`;
        note.className = 'stock-note stock-low';
      } else {
        note.textContent = '✓ In stock — ships within 1–2 business days';
        note.className = 'stock-note stock-in';
      }
    }).catch(() => {});
  }

  // ── Counter Animation ──────────────────────────
  const counters = document.querySelectorAll('.stat-num[data-target]');
  const counterObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const el = entry.target;
        const target = parseFloat(el.dataset.target);
        const suffix = el.dataset.suffix || '';
        const duration = 2000;
        const start = performance.now();
        const animate = (now) => {
          const progress = Math.min((now - start) / duration, 1);
          const ease = 1 - Math.pow(1 - progress, 3);
          const value = target * ease;
          el.textContent = (Number.isInteger(target) ? Math.round(value) : value.toFixed(1)) + suffix;
          if (progress < 1) requestAnimationFrame(animate);
        };
        requestAnimationFrame(animate);
        counterObserver.unobserve(el);
      }
    });
  }, { threshold: 0.5 });
  counters.forEach(c => counterObserver.observe(c));

  // ── Newsletter Form ────────────────────────────
  document.querySelectorAll('.newsletter-form').forEach(form => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = form.querySelector('input[type="email"]');
      const btn   = form.querySelector('button');
      if (!input?.value || btn.disabled) return;
      const orig = btn.textContent;
      btn.disabled = true;
      let ok = false;
      let code = '';
      try {
        const res = await fetch('/api/newsletter', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: input.value })
        });
        ok = res.ok;
        if (ok) code = (await res.json().catch(() => ({}))).code || '';
      } catch { /* offline, or site opened without the server */ }
      if (code) {
        try { localStorage.setItem('hom_coupon', code); } catch { /* ignore */ }
        Cart.showToast(`🎉 Use code ${code} at checkout for 10% off`);
      }
      btn.textContent = ok ? (code ? `✓ Code: ${code}` : '✓ Subscribed!') : 'Try again';
      btn.style.background = ok ? '#3B5E3A' : '';
      if (ok) input.value = '';
      setTimeout(() => { btn.textContent = orig; btn.style.background = ''; btn.disabled = false; }, 3000);
    });
  });

  // ── Hero Particles ─────────────────────────────
  const heroSection = document.querySelector('.hero');
  if (heroSection) {
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1;opacity:0.4';
    heroSection.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    let particles = [];
    const resize = () => { canvas.width = heroSection.offsetWidth; canvas.height = heroSection.offsetHeight; };
    resize();
    window.addEventListener('resize', resize);
    for (let i = 0; i < 40; i++) {
      particles.push({ x: Math.random()*canvas.width, y: Math.random()*canvas.height, r: Math.random()*2+0.5, dx: (Math.random()-0.5)*0.3, dy: -Math.random()*0.6-0.2, opacity: Math.random()*0.6+0.2 });
    }
    const drawParticles = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach(p => {
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI*2);
        ctx.fillStyle = `rgba(200,150,62,${p.opacity})`; ctx.fill();
        p.x += p.dx; p.y += p.dy;
        if (p.y < -10) { p.y = canvas.height+10; p.x = Math.random()*canvas.width; }
        if (p.x < -10) p.x = canvas.width+10;
        if (p.x > canvas.width+10) p.x = -10;
      });
      requestAnimationFrame(drawParticles);
    };
    drawParticles();
  }

  // ── Rotating Tagline ───────────────────────────
  const taglines = ['Pure. Sacred. Powerful.','Where Tradition Meets Wellness.','Gold From the Earth, For Your Health.','Nature\'s Finest, Lab-Certified.','Rooted in Heritage. Backed by Science.'];
  const taglineEl = document.querySelector('.hero-rotating-tagline');
  if (taglineEl) {
    let idx = 0;
    taglineEl.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
    setInterval(() => {
      taglineEl.style.opacity = '0'; taglineEl.style.transform = 'translateY(8px)';
      setTimeout(() => {
        idx = (idx + 1) % taglines.length;
        taglineEl.textContent = taglines[idx];
        taglineEl.style.opacity = '1'; taglineEl.style.transform = 'translateY(0)';
      }, 400);
    }, 3500);
  }

  // ── Product Thumbnail Switcher ─────────────────
  document.querySelectorAll('.product-thumb').forEach(thumb => {
    thumb.addEventListener('click', () => {
      document.querySelectorAll('.product-thumb').forEach(t => t.classList.remove('active'));
      thumb.classList.add('active');
      const img = thumb.querySelector('img');
      const main = document.getElementById('main-product-img');
      if (main && img) { main.src = img.src; main.alt = img.alt; }
    });
    thumb.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); thumb.click(); } });
  });

});
