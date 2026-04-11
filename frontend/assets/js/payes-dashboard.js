const API_BASE_URL = window.__API_BASE_URL__ || '';

const authToken = localStorage.getItem('authToken');
const authUserRaw = localStorage.getItem('authUser');
const connectedUser = authUserRaw ? JSON.parse(authUserRaw) : null;

if (!authToken || !authUserRaw) {
    window.location.href = 'login.html';
    throw new Error('Utilisateur non connecte');
}

const logoutButton = document.getElementById('logoutButton');
const totalHeistsEl = document.getElementById('totalHeists');
const totalDrugSalesEl = document.getElementById('totalDrugSales');
const totalMoneyEl = document.getElementById('totalMoney');
const heistsByTypeBody = document.getElementById('heistsByTypeBody');
const drugsByTypeBody = document.getElementById('drugsByTypeBody');
const playersRecapBody = document.getElementById('playersRecapBody');
const salaryBody = document.getElementById('salaryBody');
const adminPanel = document.getElementById('adminPanel');
const adminUsersBody = document.getElementById('adminUsersBody');
const backupsBody = document.getElementById('backupsBody');
const createBackupButton = document.getElementById('createBackupButton');
const resetAllActivityButton = document.getElementById('resetAllActivityButton');

let usersCache = [];
let totalMoneyGeneratedCache = 0;
let gradesCache = [];

function formatMoney(value) {
    return new Intl.NumberFormat('fr-FR').format(Number(value || 0)) + ' $';
}

function formatPercent(value) {
    return (Number(value || 0) * 100).toFixed(2) + ' %';
}

function formatDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return '-';
    }

    return date.toLocaleString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function formatBytes(value) {
    const parsed = Number(value || 0);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return '0 B';
    }

    if (parsed < 1024) {
        return `${parsed} B`;
    }

    if (parsed < 1024 * 1024) {
        return `${(parsed / 1024).toFixed(1)} KB`;
    }

    return `${(parsed / (1024 * 1024)).toFixed(2)} MB`;
}

function renderHeistsByType(rows) {
    heistsByTypeBody.innerHTML = '';

    rows.forEach((item) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${item.type}</td>
            <td>${item.totalCount}</td>
            <td>${formatMoney(item.totalGain)}</td>
        `;
        heistsByTypeBody.appendChild(tr);
    });

    if (!rows.length) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="3">Aucune casse enregistree.</td>';
        heistsByTypeBody.appendChild(tr);
    }
}

function renderDrugsByType(rows) {
    drugsByTypeBody.innerHTML = '';

    rows.forEach((item) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${item.type}</td>
            <td>${item.totalSales}</td>
            <td>${item.totalQuantity}</td>
            <td>${formatMoney(item.totalRevenue)}</td>
        `;
        drugsByTypeBody.appendChild(tr);
    });

    if (!rows.length) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="4">Aucune vente de drogue enregistree.</td>';
        drugsByTypeBody.appendChild(tr);
    }
}

function renderPlayersRecap(rows) {
    if (!playersRecapBody) {
        return;
    }

    playersRecapBody.innerHTML = '';

    rows.forEach((user) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${user.pseudo}</td>
            <td>${Number(user.totalDrugSales || 0)}</td>
            <td>${Number(user.totalHeists || 0)}</td>
        `;
        playersRecapBody.appendChild(tr);
    });

    if (!rows.length) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="3">Aucun joueur trouve.</td>';
        playersRecapBody.appendChild(tr);
    }
}

function renderSalaries() {
    salaryBody.innerHTML = '';

    usersCache.forEach((user) => {
        const autoShare = totalMoneyGeneratedCache > 0 ? user.totalMoneyGenerated / totalMoneyGeneratedCache : 0;
        const configuredSharePercentage = user.groupSharePercentage == null ? null : Number(user.groupSharePercentage);
        const share = configuredSharePercentage == null ? autoShare : configuredSharePercentage / 100;
        const blanchPercent = user.salaryPercentage == null ? 35 : Number(user.salaryPercentage);
        const salaryBase = Number(user.totalMoneyGenerated || 0);
        const launderedMoney = salaryBase * (blanchPercent / 100);
        const salary = launderedMoney * share;
        const shareLabel = configuredSharePercentage == null
            ? formatPercent(share)
            : `${configuredSharePercentage.toFixed(2)} %`;

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${user.pseudo}</td>
            <td>${formatMoney(user.totalMoneyGenerated)}</td>
            <td>${formatMoney(launderedMoney)} (${blanchPercent.toFixed(2)} %)</td>
            <td>${shareLabel}</td>
            <td>${formatMoney(salary)}</td>
        `;
        salaryBody.appendChild(tr);
    });

    if (!usersCache.length) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="5">Aucun joueur trouve.</td>';
        salaryBody.appendChild(tr);
    }
}

function renderAdminUsers(users) {
    adminUsersBody.innerHTML = '';

    users.forEach((user) => {
        const tr = document.createElement('tr');

        const gradeOptions = gradesCache
            .map((grade) => {
                const selected = Number(user.grade) === Number(grade.id) ? 'selected' : '';
                return `<option value="${grade.id}" ${selected}>${grade.name}</option>`;
            })
            .join('');

        const percentValue = user.salaryPercentage == null ? '' : String(user.salaryPercentage);
        const groupShareValue = user.groupSharePercentage == null ? '' : String(user.groupSharePercentage);

        tr.innerHTML = `
            <td>${user.pseudo}${user.isAdmin ? ' (admin)' : ''}</td>
            <td>
                <select class="admin-grade-select" data-user-id="${user.id}">
                    ${gradeOptions}
                </select>
            </td>
            <td>
                <input class="admin-percent-input" data-user-id="${user.id}" type="number" min="0" max="100" step="0.01" value="${percentValue}" placeholder="auto" />
            </td>
            <td>
                <input class="admin-percent-input admin-share-input" data-user-id="${user.id}" type="number" min="0" max="100" step="0.01" value="${groupShareValue}" placeholder="auto" />
            </td>
            <td>
                <button class="admin-save-btn" data-user-id="${user.id}" type="button">Enregistrer</button>
                <button class="admin-reset-btn" data-user-id="${user.id}" data-user-pseudo="${user.pseudo}" type="button">Remettre a zero</button>
            </td>
        `;

        adminUsersBody.appendChild(tr);
    });

    if (!users.length) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="5">Aucun utilisateur.</td>';
        adminUsersBody.appendChild(tr);
    }
}

function renderBackups(rows) {
    if (!backupsBody) {
        return;
    }

    backupsBody.innerHTML = '';

    rows.forEach((item) => {
        const tr = document.createElement('tr');
        const downloadUrl = `${API_BASE_URL}/api/admin/${encodeURIComponent(connectedUser.pseudo)}/backups/${encodeURIComponent(item.fileName)}`;
        const reportUrl = item.reportFileName
            ? `${API_BASE_URL}/api/admin/${encodeURIComponent(connectedUser.pseudo)}/backups/${encodeURIComponent(item.reportFileName)}`
            : null;
        const jsonUrl = item.jsonFileName
            ? `${API_BASE_URL}/api/admin/${encodeURIComponent(connectedUser.pseudo)}/backups/${encodeURIComponent(item.jsonFileName)}`
            : null;

        tr.innerHTML = `
            <td>${item.fileName}</td>
            <td>${reportUrl ? `<a class="backup-link" href="${reportUrl}" target="_blank" rel="noopener">Ouvrir rapport</a>` : '-'}</td>
            <td>${jsonUrl ? `<a class="backup-link" href="${jsonUrl}" target="_blank" rel="noopener">Ouvrir JSON</a>` : '-'}</td>
            <td>${formatDateTime(item.createdAt)}</td>
            <td>${formatBytes(item.sizeBytes)}</td>
            <td><a class="backup-link" href="${downloadUrl}">Telecharger DB</a></td>
        `;

        backupsBody.appendChild(tr);
    });

    if (!rows.length) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="6">Aucune sauvegarde disponible.</td>';
        backupsBody.appendChild(tr);
    }
}

async function loadBackups() {
    if (!connectedUser?.pseudo) {
        return;
    }

    const response = await fetch(`${API_BASE_URL}/api/admin/${encodeURIComponent(connectedUser.pseudo)}/backups`);
    const data = await response.json();

    if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Erreur chargement sauvegardes');
    }

    renderBackups(data.backups || []);
}

async function createBackupNow() {
    if (!connectedUser?.pseudo) {
        return;
    }

    const response = await fetch(`${API_BASE_URL}/api/admin/${encodeURIComponent(connectedUser.pseudo)}/backups`, {
        method: 'POST'
    });
    const data = await response.json();

    if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Erreur creation sauvegarde');
    }

    await loadBackups();
}

async function loadAdminPanel() {
    if (!connectedUser?.pseudo) {
        return;
    }

    const response = await fetch(`${API_BASE_URL}/api/admin/${encodeURIComponent(connectedUser.pseudo)}/users-settings`);
    const data = await response.json();

    if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Erreur chargement admin');
    }

    gradesCache = data.grades || [];
    adminPanel.classList.remove('hidden');
    renderAdminUsers(data.users || []);
    await loadBackups();
}

async function saveAdminUserSettings(userId) {
    const gradeSelect = adminUsersBody.querySelector(`.admin-grade-select[data-user-id="${userId}"]`);
    const percentInput = adminUsersBody.querySelector(`.admin-percent-input[data-user-id="${userId}"]`);
    const shareInput = adminUsersBody.querySelector(`.admin-share-input[data-user-id="${userId}"]`);

    if (!gradeSelect || !percentInput || !shareInput) {
        return;
    }

    const payload = {
        grade: Number(gradeSelect.value),
        salaryPercentage: percentInput.value === '' ? null : Number(percentInput.value),
        groupSharePercentage: shareInput.value === '' ? null : Number(shareInput.value)
    };

    const response = await fetch(`${API_BASE_URL}/api/admin/${encodeURIComponent(connectedUser.pseudo)}/users/${userId}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Erreur sauvegarde admin');
    }

    await Promise.all([loadPayesSummary(), loadAdminPanel()]);
}

async function resetAdminUserActivity(userId, userPseudo) {
    const response = await fetch(`${API_BASE_URL}/api/admin/${encodeURIComponent(connectedUser.pseudo)}/users/${userId}/reset-activity`, {
        method: 'POST'
    });

    const data = await response.json();
    if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Erreur remise a zero utilisateur');
    }

    await Promise.all([loadPayesSummary(), loadAdminPanel()]);
    alert(`Activites remises a zero pour ${userPseudo}.`);
}

async function resetAllActivity() {
    const response = await fetch(`${API_BASE_URL}/api/admin/${encodeURIComponent(connectedUser.pseudo)}/reset-all-activity`, {
        method: 'POST'
    });

    const data = await response.json();
    if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Erreur remise a zero globale');
    }

    await Promise.all([loadPayesSummary(), loadAdminPanel()]);
    alert(`Remise a zero terminee (hors Armurie/Fleeca): ${Number(data.heistsDeleted || 0)} casses et ${Number(data.drugSalesDeleted || 0)} ventes supprimees.`);
}

function renderSummary(data) {
    totalHeistsEl.textContent = String(data.totals.totalHeists || 0);
    totalDrugSalesEl.textContent = String(data.totals.totalDrugSales || 0);
    totalMoneyEl.textContent = formatMoney(data.totals.totalMoneyGenerated || 0);

    usersCache = data.users || [];
    totalMoneyGeneratedCache = Number(data.totals.totalMoneyGenerated || 0);

    renderHeistsByType(data.heistsByType || []);
    renderDrugsByType(data.drugSalesByType || []);
    renderPlayersRecap(usersCache);
    renderSalaries();
}

async function loadPayesSummary() {
    const response = await fetch(`${API_BASE_URL}/api/payes-summary`);
    const data = await response.json();

    if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Erreur chargement payes');
    }

    renderSummary(data);
}

logoutButton.addEventListener('click', () => {
    localStorage.removeItem('authToken');
    localStorage.removeItem('authUser');
    window.location.href = 'login.html';
});

if (adminUsersBody) {
    adminUsersBody.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
            return;
        }

        const userId = target.getAttribute('data-user-id');
        if (!userId) {
            return;
        }

        if (target.classList.contains('admin-save-btn')) {
            saveAdminUserSettings(Number(userId)).catch((error) => alert(error.message));
            return;
        }

        if (!target.classList.contains('admin-reset-btn')) {
            return;
        }

        const userPseudo = target.getAttribute('data-user-pseudo') || 'cet utilisateur';
        const shouldReset = window.confirm(`Confirmer la remise a zero des activites de ${userPseudo} ?`);

        if (!shouldReset) {
            return;
        }

        resetAdminUserActivity(Number(userId), userPseudo).catch((error) => alert(error.message));
    });
}

if (createBackupButton) {
    createBackupButton.addEventListener('click', () => {
        createBackupNow()
            .then(() => alert('Sauvegarde creee avec succes.'))
            .catch((error) => alert(error.message));
    });
}

if (resetAllActivityButton) {
    resetAllActivityButton.addEventListener('click', () => {
        const shouldReset = window.confirm('Confirmer la remise a zero des casses (hors Armurie/Fleeca) et des ventes de drogues ?');
        if (!shouldReset) {
            return;
        }

        resetAllActivity().catch((error) => alert(error.message));
    });
}

loadPayesSummary().catch(() => {
    renderHeistsByType([]);
    renderDrugsByType([]);
    renderPlayersRecap([]);
    usersCache = [];
    totalMoneyGeneratedCache = 0;
    renderSalaries();
});

loadAdminPanel().catch(() => {
    if (adminPanel) {
        adminPanel.classList.add('hidden');
    }

    renderBackups([]);
});
