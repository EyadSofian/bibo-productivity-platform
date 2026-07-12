import { createContext, useContext } from "react";

// Lets a detail page (e.g. EmployeeDetail) push its title into the app header
// so the topbar can show the member's name instead of the section label.
type DetailHeader = { setTitle: (title: string | null) => void };

export const DetailHeaderContext = createContext<DetailHeader>({ setTitle: () => {} });
export const useDetailHeader = () => useContext(DetailHeaderContext);
