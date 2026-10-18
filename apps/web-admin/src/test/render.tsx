import { render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import i18n from "../i18n";
import { BusinessProvider } from "../app/useBusinesses";
import type { Business } from "../api/types";

export const BUSINESS: Business = {
  id: "biz-1",
  name: "Engosoft",
  kind: "team",
  owner_user_id: "owner-1",
  screenshot_retention_days: null,
  screenshot_interval_s: 300,
  idle_threshold_s: 300,
  allow_employee_override: false,
  screenshot_mode: "privacy",
  screenshot_skip_apps: [],
};

/** Renders a page inside the router and business context it expects, in the
 *  given language (English by default so assertions read naturally). */
export async function renderPage(ui: ComponentProps<typeof Route>["element"], { path = "/", route = "/", lang = "en" } = {}) {
  await i18n.changeLanguage(lang);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <BusinessProvider>
        <Routes>
          <Route path={route} element={ui} />
        </Routes>
      </BusinessProvider>
    </MemoryRouter>,
  );
}
