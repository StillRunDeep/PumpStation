/**
 * 访问密码验证模块
 * 通过输入访问密码或URL token来访问页面
 */

// 预设的访问密码
const ACCESS_PASSWORD = 'pum123456';
// 预设的有效token列表
const VALID_TOKENS = [
  'pum123456'
];
// sessionStorage 键名
const SESSION_KEY = 'pump_station_verified';

/**
 * 验证密码是否正确
 * @param {string} password - 要验证的密码
 * @returns {boolean} 是否正确
 */
function validatePassword(password) {
  if (!password) return false;
  return password === ACCESS_PASSWORD;
}

/**
 * 验证token是否正确
 * @param {string} token - 要验证的token
 * @returns {boolean} 是否正确
 */
function validateToken(token) {
  if (!token) return false;
  return VALID_TOKENS.includes(token);
}

/**
 * 从URL获取token参数
 * @returns {string|null} token值或null
 */
function getTokenFromUrl() {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get('token');
}

/**
 * 检查是否已经验证过
 * @returns {boolean} 是否已经验证
 */
function isVerified() {
  try {
    return sessionStorage.getItem(SESSION_KEY) === 'true';
  } catch (e) {
    return false;
  }
}

/**
 * 设置验证状态
 */
function setVerified() {
  try {
    sessionStorage.setItem(SESSION_KEY, 'true');
  } catch (e) {
    // 忽略存储错误
  }
}

/**
 * 显示密码验证页面
 */
function showPasswordVerificationPage() {
  const verifyDiv = document.createElement('div');
  verifyDiv.id = 'password-verify-page';
  verifyDiv.innerHTML = `
    <div class="password-verify-container">
      <div class="password-verify-card">
        <div class="password-verify-icon">🔒</div>
        <h1>访问验证</h1>
        <p class="password-prompt">请输入访问密码</p>
        <div class="password-verify-form">
          <div class="password-input-container">
            <input
              type="password"
              id="password-input"
              class="password-input"
            />
            <button type="button" id="toggle-password" class="toggle-password-btn">
              👁️
            </button>
          </div>
          <button id="password-verify-btn" class="btn-password-verify">
            验证
          </button>
        </div>
        <div id="password-error-msg" class="password-error" hidden>密码输入错误</div>
      </div>
    </div>
  `;

  document.body.appendChild(verifyDiv);

  const input = document.getElementById('password-input');
  const btn = document.getElementById('password-verify-btn');
  const toggleBtn = document.getElementById('toggle-password');
  const errorMsg = document.getElementById('password-error-msg');
  
  // 小眼睛按钮事件
  let isPasswordVisible = false;
  toggleBtn.addEventListener('click', () => {
    isPasswordVisible = !isPasswordVisible;
    input.type = isPasswordVisible ? 'text' : 'password';
    toggleBtn.textContent = isPasswordVisible ? '👁️‍🗨️' : '👁️';
  });

  btn.addEventListener('click', () => {
    const password = input.value.trim();
    if (validatePassword(password)) {
      setVerified();
      verifyDiv.remove();
    } else {
      errorMsg.hidden = false;
      input.style.borderColor = '#c0392b';
    }
  });

  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      btn.click();
    }
  });

  input.addEventListener('input', () => {
    errorMsg.hidden = true;
    input.style.borderColor = '#ccd6e0';
  });

  input.focus();
}

/**
 * 初始化密码验证
 */
export function initTokenVerification() {
  // 先检查是否已经验证过
  if (isVerified()) {
    return true;
  }
  
  // 检查URL中的token
  const token = getTokenFromUrl();
  if (validateToken(token)) {
    setVerified();
    return true;
  }
  
  // 显示密码验证页面
  showPasswordVerificationPage();
  return false;
}