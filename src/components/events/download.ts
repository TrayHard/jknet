/**
 * Hands a text file to the browser as a download: the calendar file of an
 * event on the website and in the web app. The launcher saves through its
 * core instead (`EventsPlatform.saveIcs`).
 */
export function downloadText(fileName: string, text: string, type = "text/calendar;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  // The download has started from the object URL by now; a moment later it is let go.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
