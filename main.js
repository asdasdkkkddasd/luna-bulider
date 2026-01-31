const calculateBtn = document.getElementById('calculate-btn');
const resultDiv = document.getElementById('result');
const themeSwitch = document.getElementById('theme-switch');
const html = document.documentElement;

// 테마 설정
function setTheme(theme) {
    html.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    themeSwitch.checked = theme === 'dark';
}

// 페이지 로드 시 저장된 테마 확인
document.addEventListener('DOMContentLoaded', () => {
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme);
});

// 테마 전환
themeSwitch.addEventListener('change', () => {
    const theme = themeSwitch.checked ? 'dark' : 'light';
    setTheme(theme);
});


calculateBtn.addEventListener('click', () => {
    const year = document.getElementById('year').value;
    const month = document.getElementById('month').value;
    const day = document.getElementById('day').value;
    const hour = document.getElementById('hour').value;

    if (!year || !month || !day || !hour) {
        resultDiv.innerHTML = "<p>모든 값을 입력해주세요.</p>";
        return;
    }

    resultDiv.innerHTML = `<p>당신의 사주팔자 결과는 다음과 같습니다...</p>`;
    // 여기에 실제 사주팔자 계산 로직을 추가할 수 있습니다.
});
