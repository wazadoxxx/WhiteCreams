const playerNameEl = document.getElementById('playerName');
const playerGradeEl = document.getElementById('playerGrade');
const totalMoneyEl = document.getElementById('totalMoney');
const totalDrugsEl = document.getElementById('totalDrugs');
const totalHeistsEl = document.getElementById('totalHeists');
const recentHeistsBody = document.getElementById('recentHeistsBody');
const logoutButton = document.getElementById('logoutButton');
const API_BASE_URL = window.__API_BASE_URL__ || '';

const authToken = localStorage.getItem('authToken');
const authUserRaw = localStorage.getItem('authUser');

if (!authToken || !authUserRaw) {
  window.location.href = 'login.html';
  throw new Error('Utilisateur non connecte');
}

const connectedUser = JSON.parse(authUserRaw);

const gradeClassNames = ['grade-leader', 'grade-co-leader', 'grade-officier', 'grade-membre-confirme', 'grade-member'];

function formatMoney(value) {
  return new Intl.NumberFormat('fr-FR').format(value) + ' $';
}

function formatDate(dateIso) {
  const date = new Date(dateIso);
  return date.toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function gradeToCssClass(gradeName) {
  const normalized = String(gradeName || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (normalized === 'leader') return 'grade-leader';
  if (normalized === 'co-leader') return 'grade-co-leader';
  if (normalized === 'officier') return 'grade-officier';
  if (normalized === 'membre confirme') return 'grade-membre-confirme';
  return 'grade-member';
}

function renderIdentity(user) {
  playerNameEl.textContent = user?.pseudo || connectedUser.pseudo;

  if (!playerGradeEl) {
    return;
  }

  const gradeLabel = user?.gradeName || connectedUser.gradeName || 'Membre';
  playerGradeEl.textContent = gradeLabel;
  playerGradeEl.classList.remove(...gradeClassNames);
  playerGradeEl.classList.add(gradeToCssClass(gradeLabel));
}

function renderSummary(summary) {
  totalMoneyEl.textContent = formatMoney(summary.totalMoney || 0);
  totalDrugsEl.textContent = String(summary.totalDrugsSold || 0);
  totalHeistsEl.textContent = String(summary.totalHeists || 0);
}

function renderRecentHeists(heists) {
  recentHeistsBody.innerHTML = '';

  heists.slice(0, 3).forEach((heist) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${formatDate(heist.date)}</td>
      <td>${heist.name}</td>
      <td>${heist.quantity ?? '-'}</td>
      <td>${formatMoney(heist.gain)}</td>
    `;
    recentHeistsBody.appendChild(row);
  });

  if (!heists.length) {
    const row = document.createElement('tr');
    row.innerHTML = '<td colspan="4">Aucune activite recente.</td>';
    recentHeistsBody.appendChild(row);
  }
}

async function loadSupabasePlayer() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/player/1`);
    const data = await response.json();
    const player = data?.player || data;

    if (!response.ok || data?.ok === false || !player) {
      return;
    }

    if (playerNameEl && player.name) {
      playerNameEl.textContent = player.name;
    }

    if (totalMoneyEl && player.total_money != null) {
      totalMoneyEl.textContent = formatMoney(Number(player.total_money) || 0);
    }
  } catch (error) {
    // Keep the existing dashboard data when the Supabase-backed endpoint is unavailable.
  }
}

async function loadDashboard() {
  renderIdentity(connectedUser);

  try {
    const [dashboardResponse, cassesResponse] = await Promise.all([
      fetch(`${API_BASE_URL}/api/dashboard/${encodeURIComponent(connectedUser.pseudo)}`),
      fetch(`${API_BASE_URL}/api/casses/${encodeURIComponent(connectedUser.pseudo)}`)
    ]);

    const dashboardData = await dashboardResponse.json();
    const cassesData = await cassesResponse.json();

    if (!dashboardResponse.ok || !dashboardData.ok) {
      throw new Error(dashboardData.error || 'Erreur dashboard');
    }

    if (!cassesResponse.ok || !cassesData.ok) {
      throw new Error(cassesData.error || 'Erreur chargement casses');
    }

    if (dashboardData.user) {
      renderIdentity(dashboardData.user);
      localStorage.setItem('authUser', JSON.stringify({
        ...connectedUser,
        ...dashboardData.user
      }));
    }

    renderSummary(dashboardData.summary);

    const recentHeists = (cassesData.heists || []).slice(0, 3).map((item) => ({
      name: item.type,
      quantity: item.activityType === 'drogue' ? (item.quantity ?? 0) : '-',
      gain: item.gain,
      date: item.date
    }));

    renderRecentHeists(recentHeists);
    await loadSupabasePlayer();
  } catch (error) {
    renderSummary({ totalMoney: 0, totalDrugsSold: 0, totalHeists: 0 });
    renderRecentHeists([]);
    await loadSupabasePlayer();
  }
}

logoutButton.addEventListener('click', () => {
  localStorage.removeItem('authToken');
  localStorage.removeItem('authUser');
  window.location.href = 'login.html';
});

loadDashboard();
