// String utilities for fixed-width terminal display

/** Strip ANSI escape sequences for visible length calculation */
export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

export function padRight(text: string, width: number, char = ' '): string {
  if (text.length >= width) return text.substring(0, width);
  return text + char.repeat(width - text.length);
}

export function padLeft(text: string, width: number, char = ' '): string {
  if (text.length >= width) return text.substring(0, width);
  return char.repeat(width - text.length) + text;
}

export function center(text: string, width: number, char = ' '): string {
  if (text.length >= width) return text.substring(0, width);
  const left = Math.floor((width - text.length) / 2);
  const right = width - text.length - left;
  return char.repeat(left) + text + char.repeat(right);
}

export function truncate(text: string, maxWidth: number, ellipsis = '...'): string {
  if (text.length <= maxWidth) return text;
  return text.substring(0, maxWidth - ellipsis.length) + ellipsis;
}

export function wordWrap(text: string, width: number): string[] {
  const lines: string[] = [];
  const paragraphs = text.split('\n');

  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      lines.push('');
      continue;
    }

    const words = paragraph.split(' ');
    let currentLine = '';

    for (const word of words) {
      if (currentLine.length === 0) {
        currentLine = word;
      } else if (currentLine.length + 1 + word.length <= width) {
        currentLine += ' ' + word;
      } else {
        lines.push(currentLine);
        currentLine = word;
      }
    }

    if (currentLine.length > 0) {
      lines.push(currentLine);
    }
  }

  return lines;
}

export function horizontalLine(width: number, char = '─'): string {
  return char.repeat(width);
}

export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const year = String(d.getFullYear()).slice(-2);
  return `${month}/${day}/${year}`;
}

export function formatTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  let hours = d.getHours();
  const ampm = hours >= 12 ? 'pm' : 'am';
  hours = hours % 12 || 12;
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}${ampm}`;
}

export function formatDateTime(date: Date | string): string {
  return `${formatDate(date)} ${formatTime(date)}`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}
