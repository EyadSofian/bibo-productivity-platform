import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { listMyBusinesses } from "./api/endpoints";
import type { Business } from "./api/types";

const SELECTED_KEY = "ctracking.admin.selectedBusiness";

type BusinessStore = {
  businesses: Business[];
  selected: Business | null;
  selectedId: string | null;
  setSelectedId: (id: string) => void;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
};

// Loads the owner's businesses and tracks a selected one (persisted). Lifted into
// a context so the topbar picker and every page (Dashboard, Employees, Settings)
// share ONE instance — switching business anywhere updates all of them.
function useBusinessStore(): BusinessStore {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [selectedId, setSelectedIdState] = useState<string | null>(
    () => localStorage.getItem(SELECTED_KEY),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listMyBusinesses();
      setBusinesses(res.businesses);
      setSelectedIdState((cur) => {
        if (cur && res.businesses.some((b) => b.id === cur)) return cur;
        return res.businesses[0]?.id ?? null;
      });
    } catch {
      setError("Could not load businesses.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const setSelectedId = useCallback((id: string) => {
    localStorage.setItem(SELECTED_KEY, id);
    setSelectedIdState(id);
  }, []);

  const selected = businesses.find((b) => b.id === selectedId) ?? null;

  return {
    businesses,
    selected,
    selectedId: selected?.id ?? null,
    setSelectedId,
    loading,
    error,
    reload,
  };
}

const BusinessContext = createContext<BusinessStore | null>(null);

export function BusinessProvider({ children }: { children: ReactNode }) {
  const store = useBusinessStore();
  return createElement(BusinessContext.Provider, { value: store }, children);
}

// Consumer — same shape as before, so pages need no changes beyond living under
// <BusinessProvider>.
export function useBusinesses(): BusinessStore {
  const ctx = useContext(BusinessContext);
  if (!ctx) throw new Error("useBusinesses must be used within a BusinessProvider");
  return ctx;
}
