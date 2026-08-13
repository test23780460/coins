import './styles.css';
import { getToken, login, clearToken } from './api.js';
import { mountDashboard } from './dashboard.js';
import { toast } from './toast.js';

const app = document.getElementById('app');
let dashboard = null;

function showLoading() {
  app.innerHTML = `
    <div class="loading-screen">
      <div class="spinner" aria-hidden="true"></div>
      <div>Loading…</div>
    </div>`;
}

function showLogin(errorMessage = '') {
  if (dashboard) {
    dashboard.destroy();
    dashboard = null;
  }
  app.innerHTML = `
    <div class="login-page">
      <div class="login-card">
        <div class="login-brand">
          <h1>SkyBlock Coin Tracker</h1>
          <span>Personal Tracker · Sign in to continue</span>
        </div>
        <form class="login-form" id="login-form" autocomplete="on">
          <div class="field">
            <label for="password">Password</label>
            <input id="password" name="password" type="password" autocomplete="current-password" required autofocus />
          </div>
          <div class="form-error" id="login-error">${errorMessage ? escapeHtml(errorMessage) : ''}</div>
          <button class="btn btn-primary btn-block" type="submit" id="login-submit">Sign In</button>
        </form>
      </div>
    </div>`;

  const form = document.getElementById('login-form');
  const errEl = document.getElementById('login-error');
  const submit = document.getElementById('login-submit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = document.getElementById('password').value;
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    errEl.textContent = '';
    try {
      await login(password);
      toast('Welcome back', 'success');
      await showDashboard();
    } catch (err) {
      console.error(err);
      clearToken();
      errEl.textContent =
        err.status === 429
          ? 'Too many attempts. Please wait and try again.'
          : err.code === 'NETWORK'
            ? 'Backend unavailable. Check your connection.'
            : err.message || 'Authentication failed';
      submit.disabled = false;
      submit.textContent = 'Sign In';
    }
  });
}

async function showDashboard() {
  if (dashboard) {
    dashboard.destroy();
    dashboard = null;
  }
  app.innerHTML = '';
  dashboard = mountDashboard(app, {
    onLogout: () => {
      clearToken();
      toast('Logged out', 'info');
      showLogin();
    },
  });
  await dashboard.start();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function boot() {
  showLoading();
  if (getToken()) {
    try {
      await showDashboard();
      return;
    } catch {
      clearToken();
    }
  }
  showLogin();
}

boot();
