(() => {
  const qs = (s, el = document) => el.querySelector(s);

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
      const out = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.80));
      return out || blob;
    } catch {
      return blob;
    }
  }

  async function uploadBlob(blob, index, total, status, submit) {
    const optimized = await compressBlob(blob);
    const fd = new FormData();
    fd.append('image', optimized, `photo-${index}.jpg`);

    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      status.textContent = `Uploading photo ${index}/${total}${attempt > 1 ? ' — retrying…' : '…'}`;
      submit.textContent = `Uploading ${index}/${total}…`;
      try {
        const r = await fetch('/.netlify/functions/upload', {
          method: 'POST',
          headers: { Authorization: `Bearer ${getToken()}` },
          body: fd
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `Photo ${index} upload failed (${r.status})`);
        if (!data.url) throw new Error(`Photo ${index} upload returned no URL`);
        return data.url;
      } catch (err) {
        lastError = err;
        if (attempt < 2) await new Promise(r => setTimeout(r, 700));
      }
    }
    throw lastError || new Error(`Photo ${index} upload failed`);
  }

  async function saveListing(event) {
    event.preventDefault();
    event.stopImmediatePropagation();

    const form = event.currentTarget;
    const submit = form.querySelector('button[type="submit"]');
    const status = qs('#uploadStatus');
    const errorBox = qs('#formError');
    if (!submit || submit.dataset.saving === '1') return;

    if (!form.reportValidity()) return;

    submit.dataset.saving = '1';
    submit.disabled = true;
    errorBox.textContent = '';

    try {
      const previewItems = [...document.querySelectorAll('#imagePreview .image-preview-item')];
      const pendingItems = previewItems.filter(item => {
        const remove = item.querySelector('.image-remove');
        return remove?.dataset.type === 'pending' && !item.dataset.uploadedUrl;
      });

      let uploadNumber = 0;
      for (const item of pendingItems) {
        uploadNumber += 1;
        const img = item.querySelector('img');
        if (!img?.src) throw new Error(`Photo ${uploadNumber} preview is unavailable.`);

        const localResponse = await fetch(img.src);
        if (!localResponse.ok) throw new Error(`Could not read photo ${uploadNumber}.`);
        const blob = await localResponse.blob();
        const url = await uploadBlob(blob, uploadNumber, pendingItems.length, status, submit);
        item.dataset.uploadedUrl = url;
      }

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
        ? `${gallery.length} photo${gallery.length > 1 ? 's' : ''} ready. Saving listing…`
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

      const response = await fetch(endpoint, {
        method: propertyId ? 'PUT' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`
        },
        body: JSON.stringify(data)
      });
      const saved = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(saved.error || `Listing save failed (${response.status})`);

      status.textContent = 'Listing saved successfully ✓';
      submit.textContent = 'Saved ✓';

      await new Promise(r => setTimeout(r, 500));
      if (typeof closeModal === 'function') closeModal();
      if (typeof load === 'function') {
        try { await load(); }
        catch { location.reload(); }
      } else {
        location.reload();
      }
    } catch (err) {
      console.error('Reliable listing save error', err);
      errorBox.textContent = err?.message || 'Unable to save listing. Please retry.';
      status.textContent = 'Not saved. Fix the error below and retry.';
      errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } finally {
      submit.dataset.saving = '0';
      submit.disabled = false;
      if (submit.textContent !== 'Saved ✓') submit.textContent = 'Save listing';
    }
  }

  window.addEventListener('load', () => {
    const form = qs('#pf');
    if (!form) return;

    // Capture phase runs before the older dashboard submit listener.
    form.addEventListener('submit', saveListing, true);

    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.title = 'Uploads photos first, then saves the listing';
  });
})();
