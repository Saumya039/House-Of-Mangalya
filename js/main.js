/* ================================================
   HOUSE OF MANGALYA — Main JavaScript
   Full cart system + all page interactions
   ================================================ */

// ── CART STORE (localStorage) ──────────────────────
const Cart = {
  get() {
    return JSON.parse(localStorage.getItem('hom_cart') || '[]');
  },
  save(items) {
    localStorage.setItem('hom_cart', JSON.stringify(items));
    Cart.updateBadge();
    Cart.renderDrawer();
  },
  add(product, qty = 1) {
    const items = Cart.get();
    const existing = items.find(i => i.id === product.id);
    if (existing) {
      existing.qty += qty;
    } else {
      items.push({ ...product, qty });
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
      item.qty = Math.max(1, item.qty + delta);
      Cart.save(items);
    }
  },
  total() {
    return Cart.get().reduce((sum, i) => sum + i.price * i.qty, 0);
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
    list.innerHTML = '';

    if (items.length === 0) {
      emptyEl && (emptyEl.style.display = 'block');
      footerEl && (footerEl.style.display = 'none');
      return;
    }

    emptyEl && (emptyEl.style.display = 'none');
    footerEl && (footerEl.style.display = 'block');

    items.forEach(item => {
      const el = document.createElement('div');
      el.className = 'cart-item';
      el.innerHTML = `
        <img src="${item.img}" alt="${item.name}" class="cart-item-img" />
        <div class="cart-item-info">
          <p class="cart-item-name">${item.name}</p>
          <p class="cart-item-sub">${item.weight}</p>
          <div class="cart-item-row">
            <div class="cart-qty-ctrl">
              <button class="cart-qty-btn" data-id="${item.id}" data-delta="-1">−</button>
              <span>${item.qty}</span>
              <button class="cart-qty-btn" data-id="${item.id}" data-delta="1">+</button>
            </div>
            <span class="cart-item-price">₹${(item.price * item.qty).toLocaleString('en-IN')}</span>
          </div>
        </div>
        <button class="cart-remove-btn" data-id="${item.id}" aria-label="Remove item">✕</button>
      `;
      list.appendChild(el);
    });

    if (totalEl) totalEl.textContent = `₹${Cart.total().toLocaleString('en-IN')}`;

    // Bind qty & remove buttons
    list.querySelectorAll('.cart-qty-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        Cart.updateQty(btn.dataset.id, parseInt(btn.dataset.delta));
      });
    });
    list.querySelectorAll('.cart-remove-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        Cart.remove(btn.dataset.id);
      });
    });
  },
  showToast(msg) {
    let toast = document.getElementById('cart-toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
  }
};

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
    Cart.showToast('🎉 Order placed! (Demo mode — integrate your payment gateway)');
    Cart.closeDrawer();
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
    qtyNum.textContent = parseInt(qtyNum.textContent) + 1;
  });

  // ── ADD TO CART (Product Page) ─────────────────
  const addToCartBtn = document.querySelector('#add-to-cart-btn');
  if (addToCartBtn) {
    addToCartBtn.addEventListener('click', () => {
      const qty = parseInt(document.querySelector('.qty-num')?.textContent || '1');
      Cart.add({
        id:    'turmeric-1kg',
        name:  'Single-Origin Turmeric Powder',
        weight:'1 kg',
        price: 500,
        img:   'assets/product.jpg'
      }, qty);

      // Button feedback
      const orig = addToCartBtn.innerHTML;
      addToCartBtn.innerHTML = '✓ Added to Cart!';
      addToCartBtn.style.background = 'linear-gradient(135deg, #3B5E3A, #2d4a2c)';
      addToCartBtn.disabled = true;
      setTimeout(() => {
        addToCartBtn.innerHTML = orig;
        addToCartBtn.style.background = '';
        addToCartBtn.disabled = false;
      }, 2000);
    });
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
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = form.querySelector('input[type="email"]');
      const btn   = form.querySelector('button');
      if (input?.value) {
        const orig = btn.textContent;
        btn.textContent = '✓ Subscribed!';
        btn.style.background = '#3B5E3A';
        input.value = '';
        setTimeout(() => { btn.textContent = orig; btn.style.background = ''; }, 3000);
      }
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
