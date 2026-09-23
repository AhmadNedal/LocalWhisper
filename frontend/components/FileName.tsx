/**
 * A file name that reads correctly in both the Arabic and English interface.
 *
 * Inside a right-to-left line the Unicode bidi algorithm reorders names such as
 * "محاضرة 3.mp4" into "محاضرة mp4.3" or "Lecture 1.mp4" into ".mp4Lecture 1".
 * Isolating the whole name as left-to-right (like Windows Explorer does) keeps
 * the Arabic words intact and the number and extension in place:
 * "محاضرة 3.mp4".
 */
export function FileName({ name }: { name: string }) {
  const hasExtension = /\.[A-Za-z0-9]{1,6}$/.test(name);
  return (
    <bdi className="file-name-text" dir={hasExtension ? "ltr" : undefined}>
      {name}
    </bdi>
  );
}
