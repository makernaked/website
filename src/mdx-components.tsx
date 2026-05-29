import type { MDXComponents } from 'mdx/types'
const components: MDXComponents = {
  wrapper: ({ children }) => <div className="prose">{children}</div>,
}

export function useMDXComponents(): MDXComponents {
  return components
}