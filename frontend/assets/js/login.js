const form = document.getElementById('loginForm');
const pseudoInput = document.getElementById('pseudo');
const passwordInput = document.getElementById('password');
const loginButton = document.getElementById('loginButton');
const message = document.getElementById('loginMessage');

const API_BASE_URL = window.__API_BASE_URL__ || '';

function setMessage(text, type = 'default') {
    message.textContent = text;
    message.classList.remove('is-error', 'is-success');

    if (type === 'error') {
        message.classList.add('is-error');
    }

    if (type === 'success') {
        message.classList.add('is-success');
    }
}

form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const pseudo = pseudoInput.value.trim();
    const password = passwordInput.value;

    if (!pseudo || !password) {
        setMessage('Merci de remplir tous les champs.', 'error');
        return;
    }

    loginButton.disabled = true;
    loginButton.textContent = 'Connexion...';
    setMessage('Verification en cours...');

    try {
        const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ pseudo, password })
        });

        const data = await response.json();

        if (!response.ok) {
            setMessage(data.error || 'Connexion refusee.', 'error');
            return;
        }

        if (data.token) {
            localStorage.setItem('authToken', data.token);
        }

        if (data.user) {
            localStorage.setItem('authUser', JSON.stringify(data.user));
        }

        setMessage(`Connexion reussie. Bonjour ${data.user.pseudo}.`, 'success');
        setTimeout(() => {
            window.location.href = 'index.html';
        }, 700);
    } catch (error) {
        setMessage('Impossible de joindre le serveur.', 'error');
    } finally {
        loginButton.disabled = false;
        loginButton.textContent = 'Se connecter';
    }
});
