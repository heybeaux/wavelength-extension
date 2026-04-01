// Popup functionality for Wavelength Chrome Extension
document.addEventListener('DOMContentLoaded', async () => {
  const loginSection = document.getElementById('login-section');
  const connectedSection = document.getElementById('connected-section');
  const signInBtn = document.getElementById('sign-in-btn');
  const signOutBtn = document.getElementById('sign-out-btn');
  const userAvatar = document.getElementById('user-avatar');
  const userEmail = document.getElementById('user-email');

  function showSection(section) {
    loginSection.style.display = 'none';
    connectedSection.style.display = 'none';
    section.style.display = 'block';
  }

  function updateUserInfo(info) {
    if (info.email) {
      userEmail.textContent = info.email;
    }
    const letter = (info.displayName || info.name || info.email || '?').charAt(0).toUpperCase();
    userAvatar.textContent = letter;
  }

  async function checkAuthStatus() {
    try {
      const token = await chrome.runtime.sendMessage({ type: 'GET_TOKEN' });
      if (!token) {
        showSection(loginSection);
        return;
      }

      const userInfo = await chrome.runtime.sendMessage({ type: 'GET_USER_INFO' });
      if (userInfo?.error) {
        showSection(loginSection);
        return;
      }

      updateUserInfo(userInfo);
      showSection(connectedSection);
    } catch {
      showSection(loginSection);
    }
  }

  // Sign In — open the web app's extension auth page via window.open
  // so that window.opener is set and postMessage works back to this popup
  signInBtn.addEventListener('click', () => {
    window.open(
      'https://mywavelength.ai/auth/extension',
      '_blank',
      'width=500,height=600'
    );
  });

  // Sign Out
  signOutBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CLEAR_TOKEN' });
    userEmail.textContent = '';
    userAvatar.textContent = '?';
    showSection(loginSection);
  });

  // Listen for auth success from background script
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'AUTH_SUCCESS') {
      checkAuthStatus();
    }
  });

  // Listen for postMessage from the auth tab (window.opener channel)
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'WAVELENGTH_AUTH' && event.data?.token) {
      chrome.runtime.sendMessage({ type: 'SET_TOKEN', token: event.data.token }, () => {
        checkAuthStatus();
      });
    }
  });

  await checkAuthStatus();
});
