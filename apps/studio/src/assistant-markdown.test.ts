import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AssistantMarkdown } from './components/AssistantMarkdown';

const render = (text: string) => renderToStaticMarkup(createElement(AssistantMarkdown, { text }));

describe('assistant Markdown tables', () => {
  it('renders headers, alignment, inline formatting and an adjacent paragraph', () => {
    const html = render('Comparison\r\n| Feature | Status | Count |\r\n| :--- | :---: | ---: |\r\n| **Preview** | *Ready* | `2` |\r\n\r\nNext step.');
    expect(html).toContain('<p>Comparison</p>');
    expect(html).toContain('<th scope="col" style="text-align:left">Feature</th>');
    expect(html).toContain('<th scope="col" style="text-align:center">Status</th>');
    expect(html).toContain('<th scope="col" style="text-align:right">Count</th>');
    expect(html).toContain('<td style="text-align:left"><strong>Preview</strong></td>');
    expect(html).toContain('<td style="text-align:center"><em>Ready</em></td>');
    expect(html).toContain('<td style="text-align:right"><code>2</code></td>');
    expect(html).toContain('</table></div><p>Next step.</p>');
  });

  it('accepts optional outer pipes, escaped pipes, empty and uneven rows', () => {
    const html = render('Name | Value\n--- | ---\na\\|b | `c\\|d`\n| short |\n| | empty | ignored |');
    expect(html).toContain('<td style="text-align:left">a|b</td>');
    expect(html).toContain('<td style="text-align:left"><code>c|d</code></td>');
    expect(html).toContain('<tr><td style="text-align:left">short</td><td style="text-align:left"></td></tr>');
    expect(html).toContain('<tr><td style="text-align:left"></td><td style="text-align:left">empty</td></tr>');
    expect(html).not.toContain('ignored');
  });

  it('keeps incomplete streaming headers as text until a valid delimiter arrives', () => {
    const header = '| Feature | Status |\n';
    expect(render(header + '| --- | :')).not.toContain('<table>');
    expect(render(header + '| --- | :---: |')).toContain('<table>');
    expect(render(header + '| --- | :---: |\n| Preview |')).toContain('<td style="text-align:center"></td>');
  });

  it('does not treat ordinary pipes, mismatched headers or fenced examples as tables', () => {
    for (const text of ['one | two\nthree | four', 'one | two\n---', 'one | two\n--- | invalid', '```md\n| A | B |\n| --- | --- |\n```']) expect(render(text)).not.toContain('<table>');
  });

  it('ends tables before another block and supports single-column tables', () => {
    const html = render('| Name |\n| --- |\n| Home |\n## Next\n\nDone');
    expect(html).toContain('<td style="text-align:left">Home</td>');
    expect(html).toContain('</table></div><h4>Next</h4>');
  });

  it('keeps HTML inert and allows only safe web links inside cells', () => {
    const html = render('| Safe | Unsafe |\n| --- | --- |\n| [Guide](https://example.com) | [Run](javascript:alert) |\n| <img src=x onerror=alert(1)> | <script>alert(1)</script> |');
    expect(html).toContain('href="https://example.com" target="_blank" rel="noopener noreferrer"');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
