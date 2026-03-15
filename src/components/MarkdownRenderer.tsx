import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import { useCallback, useState } from 'react';

interface MarkdownRendererProps {
  content: string;
}

/** MIME 类型映射 */
const LANG_EXT: Record<string, string> = {
  javascript: 'js', typescript: 'ts', python: 'py', java: 'java',
  kotlin: 'kt', go: 'go', rust: 'rs', c: 'c', cpp: 'cpp',
  csharp: 'cs', ruby: 'rb', php: 'php', swift: 'swift',
  html: 'html', css: 'css', json: 'json', xml: 'xml', yaml: 'yml',
  markdown: 'md', sql: 'sql', bash: 'sh', shell: 'sh', dockerfile: 'Dockerfile',
  toml: 'toml', ini: 'ini', txt: 'txt',
};

/** 触发浏览器下载 */
function triggerDownload(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 代码块头部 - 显示语言、复制和下载按钮 */
function CodeBlock({ className, children }: { className?: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const lang = className?.replace('hljs language-', '').replace('language-', '') || '';
  const text = String(children).replace(/\n$/, '');

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);

  const handleDownload = useCallback(() => {
    const ext = LANG_EXT[lang] || lang || 'txt';
    const filename = `code_${Date.now()}.${ext}`;
    triggerDownload(text, filename);
  }, [text, lang]);

  return (
    <div className="relative group my-3 rounded-xl overflow-hidden bg-th-code border border-th-border-subtle">
      <div className="flex items-center justify-between px-4 py-2 bg-th-code-header text-xs text-th-text-muted">
        <span>{lang || 'code'}</span>
        <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={handleDownload}
            className="flex items-center gap-1 text-th-text-muted hover:text-th-text transition-colors"
            title="下载为文件"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            下载
          </button>
          <button
            onClick={handleCopy}
            className="text-th-text-muted hover:text-th-text transition-colors"
          >
            {copied ? '✓ 已复制' : '复制'}
          </button>
        </div>
      </div>
      <pre className="overflow-x-auto p-4 text-sm leading-relaxed">
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

export default function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <div className="markdown-body prose prose-sm max-w-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight, rehypeRaw]}
        components={{
          code({ className, children, ...props }) {
            const isInline = !className;
            if (isInline) {
              return (
                <code
                  className="px-1.5 py-0.5 rounded text-sm"
                  style={{
                    backgroundColor: 'var(--cc-code-inline-bg)',
                    color: 'var(--cc-code-inline-text)',
                  }}
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return <CodeBlock className={className}>{children}</CodeBlock>;
          },
          a({ children, href, ...props }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--cc-link-color)' }}
                className="hover:opacity-80 underline"
                {...props}
              >
                {children}
              </a>
            );
          },
          table({ children }) {
            return (
              <div className="overflow-x-auto my-3">
                <table className="min-w-full border border-th-border text-sm">{children}</table>
              </div>
            );
          },
          th({ children }) {
            return (
              <th className="px-3 py-2 bg-th-code border border-th-border text-left font-medium">
                {children}
              </th>
            );
          },
          td({ children }) {
            return (
              <td className="px-3 py-2 border border-th-border">{children}</td>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
