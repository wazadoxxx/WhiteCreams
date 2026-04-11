(function configureApiBaseUrl() {
    var metaTag = document.querySelector('meta[name="api-base-url"]');
    var metaValue = metaTag ? String(metaTag.content || '').trim() : '';
    var localStorageValue = String(localStorage.getItem('API_BASE_URL') || '').trim();
    var selectedBaseUrl = metaValue || localStorageValue || window.location.origin;

    window.__API_BASE_URL__ = selectedBaseUrl.replace(/\/$/, '');
})();
