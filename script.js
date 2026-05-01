// Intersection Observer для анимаций при скролле
const observerOptions = {
  root: null,
  rootMargin: '0px',
  threshold: 0.1
};

const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      observer.unobserve(entry.target);
    }
  });
}, observerOptions);

// Наблюдаем за элементами
document.addEventListener('DOMContentLoaded', () => {
  // Section titles и subs
  document.querySelectorAll('.section-title, .section-sub').forEach((el, i) => {
    el.style.setProperty('--i', i);
    observer.observe(el);
  });

  // Cards с задержкой
  document.querySelectorAll('.card').forEach((el, i) => {
    el.style.setProperty('--i', i);
    observer.observe(el);
  });

  // Mock Discord
  document.querySelectorAll('.mock-discord').forEach((el, i) => {
    el.style.setProperty('--delay', `${i * 0.2}s`);
    observer.observe(el);
  });

  // Price cards
  document.querySelectorAll('.price-card').forEach((el, i) => {
    el.style.setProperty('--delay', `${i * 0.15}s`);
    observer.observe(el);
  });

  // FAQ items
  document.querySelectorAll('.faq-item').forEach((el, i) => {
    el.style.setProperty('--delay', `${i * 0.1}s`);
    observer.observe(el);
  });

  // CTA section
  document.querySelectorAll('.cta-section').forEach(el => {
    observer.observe(el);
  });

  // Server cards
  document.querySelectorAll('.server-card').forEach((el, i) => {
    el.style.setProperty('--delay', `${i * 0.1}s`);
    observer.observe(el);
  });

  // Module cards
  document.querySelectorAll('.module-card').forEach((el, i) => {
    el.style.setProperty('--delay', `${i * 0.08}s`);
    observer.observe(el);
  });

  // Header scroll effect
  const header = document.querySelector('.site-header');
  let lastScroll = 0;

  window.addEventListener('scroll', () => {
    const currentScroll = window.pageYOffset;
    
    if (currentScroll > 50) {
      header.classList.add('scrolled');
    } else {
      header.classList.remove('scrolled');
    }
    
    lastScroll = currentScroll;
  });

  // Mouse move effect для карточек (glow следует за курсором)
  document.querySelectorAll('.card, .price-card').forEach(card => {
    card.addEventListener('mousemove', (e) => {
      const rect = card.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      card.style.setProperty('--x', `${x}px`);
      card.style.setProperty('--y', `${y}px`);
    });
  });

  // Плавное появление кнопок при загрузке
  document.querySelectorAll('.btn').forEach((btn, i) => {
    btn.style.opacity = '0';
    btn.style.transform = 'translateY(10px)';
    
    setTimeout(() => {
      btn.style.transition = 'all 0.4s ease';
      btn.style.opacity = '1';
      btn.style.transform = 'translateY(0)';
    }, i * 50);
  });
});

// Добавляем эффект параллакса для hero секции
window.addEventListener('scroll', () => {
  const scrolled = window.pageYOffset;
  const hero = document.querySelector('.hero');
  
  if (hero) {
    hero.style.transform = `translateY(${scrolled * 0.3}px)`;
    hero.style.opacity = 1 - (scrolled / 700);
  }
});