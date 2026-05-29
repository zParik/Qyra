import type { ReactElement } from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

interface Options extends Omit<RenderOptions, "wrapper"> {
  /** Initial router entry, e.g. "/tools/merge". */
  route?: string;
}

/**
 * Render a component inside the providers the real app mounts: a fresh
 * QueryClient (retries off for deterministic tests) and an in-memory router.
 */
export function renderWithProviders(ui: ReactElement, { route = "/", ...options }: Options = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
    options,
  );

  return { ...result, queryClient };
}
