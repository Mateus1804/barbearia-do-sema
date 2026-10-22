import { $, $$, openModal } from './core.js';

function bindGallery() {
  const cards = $$('.gallery-card');
  const modal = $('#galleryModal');
  if (!cards.length || !modal) return;
  let currentIndex = 0;

  const showPhoto = (index) => {
    currentIndex = (index + cards.length) % cards.length;
    const card = cards[currentIndex];
    const preview = $('#galleryPreview');
    preview.src = card.dataset.galleryImage;
    preview.alt = $('img', card).alt;
    $('#galleryCaption').textContent = card.dataset.galleryCaption;
    $('#galleryPosition').textContent = `${currentIndex + 1} / ${cards.length}`;
  };

  cards.forEach((card, index) =>
    card.addEventListener('click', () => {
      showPhoto(index);
      openModal('galleryModal');
    })
  );
  $('#galleryPrevious').addEventListener('click', () => showPhoto(currentIndex - 1));
  $('#galleryNext').addEventListener('click', () => showPhoto(currentIndex + 1));
  document.addEventListener('keydown', (event) => {
    if (modal.classList.contains('hidden')) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      showPhoto(currentIndex + (event.key === 'ArrowRight' ? 1 : -1));
    }
  });
}

export { bindGallery };
