(() => {
  const qs = (s, el = document) => el.querySelector(s);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function getToken() {
    return localStorage.getItem('creator_token') || '';
  }

  async function compressBlob(blob) {
    try {
      const bitmap = await createImageBitmap(blob);
      const maxSide = 1400;
      const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.drawImage(bitmap, 0, 0, width, height);
      bitmap.close?.();
      const out = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.78));
      return out || blob;
    } catch {
      return blob;
    }
  }

  async function fetchWithTimeout(url, options, timeoutMs = 45000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function uploadBlob(blob, number) {
    const optimized = await compressBlob(blob);
    const fd = new FormData();
    fd.append('image', optimized, `photo-${number}.jpg`);

    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await fetchWithTimeout('/.netlify/functions/upload', {
          method: 'POST',
          headers: { Authorization: `Bearer ${getToken()}` },
          body: fd
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `Photo ${number} upload failed (${r.status})`);
        if (!data.url) throw new Error(`Photo ${number} upload returned no URL`);
        return data.url;
      } catch (err) {
        lastError = err;
        if (attempt < 2) await sleep(650);
      }
    }
    throw lastError || new Error(`Photo ${number} upload failed`);
  }

  async function uploadPendingItems(items, status, submit) {
    if (!items.length) return;

    let cursor = 0;
    let completed = 0;
    const total = items.length;
    const concurrency = Math.min(3, total);

    const updateProgress = () => {
      status.textContent = `Uploading photos ${completed}/${total}…`;
      submit.textContent = `Uploading ${completed}/${total}…`;
    };
    updateProgress();

    async function worker() {
      while (true) {
        const index = cursor++;
        if (index >= total) return;
        const item = items[index];
        if (item.dataset.uploadedUrl) {
          completed += 1;
          updateProgress();
          continue;
        }

        const img = item.querySelector('img');
        if (!img?.src) throw new Error(`Photo ${index + 1} preview is unavailable.`);
        const localResponse = await fetch(img.src);
        if (!localResponse.ok) throw new Error(`Could not read photo ${index + 1}.`);
        const blob = await localResponse.blob();
        item.dataset.uploadedUrl = await uploadBlob(blob, index + 1);
        completed += 1;
        updateProgress();
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  }

  async function saveListing(event) {
    event.preventDefault();
    event.stopImmediatePropagation();

    const form = event.currentTarget;
    const submit = form.querySelector('button[type="submit"]');
    const status = qs('#uploadStatus');
    const errorBox = qs('#formError');
    const closeButton = qs('#close');
    if (!submit || submit.dataset.saving === '1') return;
    if (!form.reportValidity()) return;

    submit.dataset.saving = '1';
    submit.disabled = true;
    if (closeButton) closeButton.disabled = true;
    errorBox.textContent = '';

    try {
      const previewItems = [...document.querySelectorAll('#imagePreview .image-preview-item')];
      const pendingItems = previewItems.filter(item => {
        const remove = item.querySelector('.image-remove');
        return remove?.dataset.type === 'pending' && !item.dataset.uploadedUrl;
      });

      await uploadPendingItems(pendingItems, status, submit);

      const gallery = previewItems.map(item => {
        if (item.dataset.uploadedUrl) return item.dataset.uploadedUrl;
        const img = item.querySelector('img');
        if (!img?.src || img.src.startsWith('blob:')) return '';
        try {
          const u = new URL(img.src, location.origin);
          return u.origin === location.origin ? `${u.pathname}${u.search}` : u.href;
        } catch {
          return img.src;
        }
      }).filter(Boolean).slice(0, 12);

      status.textContent = gallery.length
        ? `${gallery.length} photo${gallery.length > 1 ? 's' : ''} uploaded. Saving listing…`
        : 'Saving listing…';
      submit.textContent = 'Saving listing…';

      const data = Object.fromEntries(new FormData(form).entries());
      const propertyId = String(data.property_id || '');
      delete data.property_id;
      delete data.images;
      data.gallery = gallery;
      data.image_url = gallery[0] || '';
      data.allow_direct = form.elements.namedItem('allow_direct')?.checked === true;
      data.published = form.elements.namedItem('published')?.checked === true;

      const endpoint = propertyId
        ? `/.netlify/functions/dashboard?action=properties&id=${encodeURIComponent(propertyId)}`
        : '/.netlify/functions/dashboard?action=properties';

      const response = await fetchWithTimeout(endpoint, {
        method: propertyId ? 'PUT' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`
        },
        body: JSON.stringify(data)
      }, 30000);
      const saved = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(saved.error || `Listing save failed (${response.status})`);

      status.textContent = 'Listing saved successfully ✓';
      submit.textContent = 'Saved ✓';
      await sleep(550);

      if (typeof closeModal === 'function') closeModal();
      if (typeof load === 'function') {
        try { await load(); }
        catch { location.reload(); }
      } else {
        location.reload();
      }
    } catch (err) {
      console.error('Listing save error', err);
      const message = err?.name === 'AbortError'
        ? 'The upload took too long. Tap Save listing to retry; photos already uploaded will not be uploaded again.'
        : (err?.message || 'Unable to save listing. Please retry.');
      errorBox.textContent = message;
      status.textContent = 'Not saved yet. You can retry without re-selecting the photos.';
      errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } finally {
      submit.dataset.saving = '0';
      submit.disabled = false;
      if (closeButton) closeButton.disabled = false;
      if (submit.textContent !== 'Saved ✓') submit.textContent = 'Save listing';
    }
  }

  function init() {
    const form = qs('#pf');
    if (!form || form.dataset.reliableSaveBound === '1') return;
    form.dataset.reliableSaveBound = '1';
    form.addEventListener('submit', saveListing, true);
    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.title = 'Uploads photos in parallel, then saves the listing';
  }

  if (document.readyState === 'complete') init();
  else window.addEventListener('load', init, { once: true });
})();
