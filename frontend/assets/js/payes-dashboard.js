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
const adminCreateUserForm = document.getElementById('adminCreateUserForm');
const newUserPseudoInput = document.getElementById('newUserPseudo');
const newUserPasswordInput = document.getElementById('newUserPassword');
const newUserGradeSelect = document.getElementById('newUserGrade');
const newUserSalaryPercentageInput = document.getElementById('newUserSalaryPercentage');
const newUserGroupSharePercentageInput = document.getElementById('newUserGroupSharePercentage');
const newUserIsAdminInput = document.getElementById('newUserIsAdmin');
const createUserButton = document.getElementById('createUserButton');
const adminCreateUserMessage = document.getElementById('adminCreateUserMessage');

let usersCache = [];
let totalMoneyGeneratedCache = 0;
let gradesCache = [];
const GRADE_ORDER_KEYS = ['leader', 'coleader', 'officier', 'membreconfirme', 'membre'];

function toGradeKey(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

function getUserGradeName(user) {
    if (user?.gradeName) {
        return user.gradeName;
    }

    if (user?.grade == null) {
        return '';
    }

    const matchedGrade = gradesCache.find((grade) => Number(grade.id) === Number(user.grade));
    return matchedGrade?.name || '';
}

function getUserGradeRank(user) {
    const gradeKey = toGradeKey(getUserGradeName(user));
    const index = GRADE_ORDER_KEYS.indexOf(gradeKey);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function sortUsersByGrade(users) {
    return [...users].sort((left, right) => {
        const rankDiff = getUserGradeRank(left) - getUserGradeRank(right);
        if (rankDiff !== 0) {
            return rankDiff;
        }

        return String(left?.pseudo || '').localeCompare(String(right?.pseudo || ''), 'fr', {
            sensitivity: 'base'
        });
    });
}

function setAdminCreateUserMessage(text, type = 'default') {
    if (!adminCreateUserMessage) {
        return;
    }

    adminCreateUserMessage.textContent = text;
    adminCreateUserMessage.classList.remove('is-error', 'is-success');

    if (type === 'error') {
        adminCreateUserMessage.classList.add('is-error');
    }

    if (type === 'success') {
        adminCreateUserMessage.classList.add('is-success');
    }
}

function parsePercentageInput(rawValue) {
    if (rawValue === null || rawValue === undefined) {
        return null;
    }

    const normalized = String(rawValue).trim().replace(',', '.');
    if (normalized === '') {
        return null;
    }

    const parsed = Number(normalized);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        return NaN;
    }

    return parsed;
}

function renderAdminCreateGradeOptions() {
    if (!newUserGradeSelect) {
        return;
    }

    newUserGradeSelect.innerHTML = gradesCache
        .map((grade, index) => `<option value="${grade.id}" ${index === gradesCache.length - 1 ? 'selected' : ''}>${grade.name}</option>`)
        .join('');
}

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
    const sortedRows = sortUsersByGrade(rows);

    sortedRows.forEach((user) => {
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
    const sortedUsers = sortUsersByGrade(usersCache);

    sortedUsers.forEach((user) => {
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
    const sortedUsers = sortUsersByGrade(users);

    sortedUsers.forEach((user) => {
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
                <button class="admin-delete-btn" data-user-id="${user.id}" data-user-pseudo="${user.pseudo}" type="button">Supprimer</button>
            </td>
        `;

        adminUsersBody.appendChild(tr);
    });

    if (!sortedUsers.length) {
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
    renderAdminCreateGradeOptions();
    adminPanel.classList.remove('hidden');
    renderAdminUsers(data.users || []);
    await loadBackups();
}

async function createAdminUser() {
    if (!connectedUser?.pseudo) {
        return;
    }

    const pseudo = newUserPseudoInput?.value.trim() || '';
    const password = newUserPasswordInput?.value || '';
    const grade = newUserGradeSelect?.value || '';
    const salaryPercentage = parsePercentageInput(newUserSalaryPercentageInput?.value);
    const groupSharePercentage = parsePercentageInput(newUserGroupSharePercentageInput?.value);
    const isAdmin = Boolean(newUserIsAdminInput?.checked);

    if (!pseudo || !password || !grade) {
        setAdminCreateUserMessage('Pseudo, mot de passe et grade sont obligatoires.', 'error');
        return;
    }

    if (Number.isNaN(salaryPercentage) || Number.isNaN(groupSharePercentage)) {
        setAdminCreateUserMessage('Les pourcentages doivent etre des nombres entre 0 et 100.', 'error');
        return;
    }

    createUserButton.disabled = true;
    setAdminCreateUserMessage('Creation en cours...');

    try {
        const response = await fetch(`${API_BASE_URL}/api/admin/${encodeURIComponent(connectedUser.pseudo)}/users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pseudo,
                password,
                grade: Number(grade),
                salaryPercentage,
                groupSharePercentage,
                isAdmin
            })
        });

        const data = await response.json();
        if (!response.ok || !data.ok) {
            throw new Error(data.error || 'Erreur creation utilisateur');
        }

        adminCreateUserForm.reset();
        renderAdminCreateGradeOptions();
        setAdminCreateUserMessage(`Utilisateur ${pseudo} cree avec succes.`, 'success');
        await Promise.all([loadPayesSummary(), loadAdminPanel()]);
    } catch (error) {
        setAdminCreateUserMessage(error.message, 'error');
    } finally {
        createUserButton.disabled = false;
    }
}

async function deleteAdminUser(userId, userPseudo) {
    const response = await fetch(`${API_BASE_URL}/api/admin/${encodeURIComponent(connectedUser.pseudo)}/users/${userId}`, {
        method: 'DELETE'
    });

    const data = await response.json();
    if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Erreur suppression utilisateur');
    }

    await Promise.all([loadPayesSummary(), loadAdminPanel()]);
    alert(`Utilisateur ${userPseudo} supprime.`);
}

async function saveAdminUserSettings(userId) {
    const gradeSelect = adminUsersBody.querySelector(`.admin-grade-select[data-user-id="${userId}"]`);
    const percentInput = adminUsersBody.querySelector(`.admin-percent-input[data-user-id="${userId}"]`);
    const shareInput = adminUsersBody.querySelector(`.admin-share-input[data-user-id="${userId}"]`);

    if (!gradeSelect || !percentInput || !shareInput) {
        return;
    }

    const parsedSalaryPercentage = parsePercentageInput(percentInput.value);
    const parsedGroupSharePercentage = parsePercentageInput(shareInput.value);

    if (Number.isNaN(parsedSalaryPercentage) || Number.isNaN(parsedGroupSharePercentage)) {
        throw new Error('Les pourcentages doivent etre des nombres entre 0 et 100.');
    }

    const payload = {
        grade: Number(gradeSelect.value),
        salaryPercentage: parsedSalaryPercentage,
        groupSharePercentage: parsedGroupSharePercentage
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

        if (target.classList.contains('admin-delete-btn')) {
            const userPseudo = target.getAttribute('data-user-pseudo') || 'cet utilisateur';
            const shouldDelete = window.confirm(`Confirmer la suppression definitive de ${userPseudo} ?`);

            if (!shouldDelete) {
                return;
            }

            deleteAdminUser(Number(userId), userPseudo).catch((error) => alert(error.message));
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

if (adminCreateUserForm) {
    adminCreateUserForm.addEventListener('submit', (event) => {
        event.preventDefault();
        createAdminUser();
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

loadPayesSummary().catch((error) => {
    console.error('Erreur chargement payes:', error);

    // Keep previous values when the API is temporarily unavailable (for example Render cold starts).
    if (!usersCache.length) {
        renderHeistsByType([]);
        renderDrugsByType([]);
        renderPlayersRecap([]);
        renderSalaries();
    }
});

loadAdminPanel().catch(() => {
    if (adminPanel) {
        adminPanel.classList.add('hidden');
    }

    renderBackups([]);
});
