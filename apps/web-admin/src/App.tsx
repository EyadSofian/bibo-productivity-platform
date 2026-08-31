import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { AuthProvider } from "./auth/AuthContext";
import { BusinessProvider } from "./useBusinesses";
import { ThemeProvider } from "./theme/ThemeProvider";
import { SignIn } from "./auth/SignIn";
import { SignupWizard } from "./auth/SignupWizard";

// Admin reports are sizeable and most sessions only visit a subset. Keep the
// authenticated shell immediate, then load each route on demand.
const Dashboard = lazy(() => import("./pages/Dashboard").then((m) => ({ default: m.Dashboard })));
const EmployeeDetail = lazy(() => import("./pages/EmployeeDetail").then((m) => ({ default: m.EmployeeDetail })));
const Devices = lazy(() => import("./pages/Devices").then((m) => ({ default: m.Devices })));
const MonitoringProfiles = lazy(() => import("./pages/MonitoringProfiles").then((m) => ({ default: m.MonitoringProfiles })));
const Organization = lazy(() => import("./pages/Organization").then((m) => ({ default: m.Organization })));
const Employees = lazy(() => import("./pages/Employees").then((m) => ({ default: m.Employees })));
const Settings = lazy(() => import("./pages/Settings").then((m) => ({ default: m.Settings })));

function PageFallback() {
  return <div className="ad-page-loader" role="status" aria-label="Loading"><span /></div>;
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/+$/, "")}>
          <Routes>
            <Route path="/login" element={<SignIn />} />
            <Route path="/signup" element={<SignupWizard />} />
            <Route element={<ProtectedRoute />}>
              <Route
                element={
                  <BusinessProvider>
                    <AppShell />
                  </BusinessProvider>
                }
              >
                <Route index element={<Suspense fallback={<PageFallback />}><Dashboard /></Suspense>} />
                <Route path="employees" element={<Suspense fallback={<PageFallback />}><Employees /></Suspense>} />
                <Route path="employees/:id" element={<Suspense fallback={<PageFallback />}><EmployeeDetail /></Suspense>} />
                <Route path="devices" element={<Suspense fallback={<PageFallback />}><Devices /></Suspense>} />
                <Route path="monitoring" element={<Suspense fallback={<PageFallback />}><MonitoringProfiles /></Suspense>} />
                <Route path="organization" element={<Suspense fallback={<PageFallback />}><Organization /></Suspense>} />
                <Route path="settings" element={<Suspense fallback={<PageFallback />}><Settings /></Suspense>} />
              </Route>
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}
