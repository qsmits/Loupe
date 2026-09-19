// File-only drag targets: leave ordinary canvas/mouse gestures untouched.
export function bindImageDropTargets(targets, onImage, onInvalid, eventRoot = document) {
  const resets = [];
  for (const target of targets.filter(Boolean)) {
    let depth = 0;
    const reset = () => {
      depth = 0;
      target.classList.remove('fringe-drop-active');
    };
    resets.push(reset);
    const isFileDrag = e => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    target.addEventListener('dragenter', e => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth++;
      target.classList.add('fringe-drop-active');
    });
    target.addEventListener('dragover', e => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      target.classList.add('fringe-drop-active');
    });
    target.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) reset();
    });
    target.addEventListener('drop', e => {
      reset();
      const file = e.dataTransfer?.files?.[0];
      // Project import owns .loupe files at document capture phase.
      if (!file || file.name.toLowerCase().endsWith('.loupe')) return;
      e.preventDefault();
      e.stopPropagation();
      if (file.type.startsWith('image/')) onImage(file);
      else onInvalid?.();
    });
  }
  // Capture also clears feedback when another handler consumes a project drop.
  const resetAll = () => resets.forEach(reset => reset());
  eventRoot.addEventListener('drop', resetAll, true);
  eventRoot.addEventListener('dragend', resetAll, true);
}
