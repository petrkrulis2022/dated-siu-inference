/**
 * Page-scoped (print pages only): reveals each "Copy" button beside a hash and makes it copy that value. Without this script the buttons stay hidden and the
 * hash is still plain, fully shown, selectable text.
 */
function setup(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("button.copy[data-copy]")) {
    button.hidden = false;
    button.addEventListener("click", async () => {
      const value = button.dataset.copy ?? "";
      try {
        await navigator.clipboard.writeText(value);
        button.textContent = "Copied";
      } catch {
        // Clipboard access refused: select the text next to the button so the reader can copy it by hand.
        const code = button.previousElementSibling;
        if (code) {
          const range = document.createRange();
          range.selectNodeContents(code);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
        button.textContent = "Select and copy";
      }
    });
  }
}

setup();
