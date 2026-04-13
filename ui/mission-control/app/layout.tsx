import "./globals.css";
import type { ReactNode } from "react";
import Script from "next/script";

import OpsChatbot from "../components/OpsChatbot";
import GlobalPlatformWalkthrough from "../components/ui/GlobalPlatformWalkthrough";
import TxtGlobalNav from "../components/ui/TxtGlobalNav";
import UiModeController from "../components/ui/UiModeController";
import { getServerRoleGroup } from "../lib/serverAuth";

const PERFORMANCE_COMPAT_BOOTSTRAP = `(function(){
  if (typeof window === "undefined") {
    return;
  }
  var globalObject = window;
  var perf = globalObject.performance;
  var compat = {
    hadPerformance: Boolean(perf),
    patched: [],
    failed: [],
    wrapped: [],
    replacedPerformance: false,
    verified: {},
  };
  var noop = function() {};
  var emptyEntries = function() {
    return [];
  };
  var stubMeasure = function(name) {
    return {
      name: typeof name === "string" ? name : "",
      entryType: "measure",
      startTime: 0,
      duration: 0,
      toJSON: function() {
        return {
          name: typeof name === "string" ? name : "",
          entryType: "measure",
          startTime: 0,
          duration: 0,
        };
      },
    };
  };
  var requiredMethods = {
    mark: noop,
    measure: stubMeasure,
    clearMarks: noop,
    clearMeasures: noop,
    clearResourceTimings: noop,
    getEntriesByName: emptyEntries,
    getEntriesByType: emptyEntries,
  };
  var nativeMethods = {};
  var rememberNativeMethod = function(name) {
    if (nativeMethods[name]) {
      return;
    }
    if (!perf || (typeof perf !== "object" && typeof perf !== "function")) {
      nativeMethods[name] = null;
      return;
    }
    try {
      if (typeof perf[name] === "function") {
        nativeMethods[name] = perf[name].bind(perf);
        return;
      }
    } catch (_bindError) {}
    nativeMethods[name] = null;
  };
  var createSafeMethod = function(name, fallback) {
    rememberNativeMethod(name);
    return function() {
      var nativeMethod = nativeMethods[name];
      if (typeof nativeMethod === "function") {
        try {
          return nativeMethod.apply(null, arguments);
        } catch (_runtimeError) {
          compat.failed.push(name + ":runtime-error");
        }
      }
      return fallback.apply(null, arguments);
    };
  };
  var patchMethod = function(target, name, value, scope) {
    if (!target || (typeof target !== "object" && typeof target !== "function")) {
      compat.failed.push(name + ":missing-target");
      return false;
    }
    try {
      Object.defineProperty(target, name, {
        configurable: true,
        writable: true,
        value: value,
      });
      if (typeof target[name] === "function") {
        compat.patched.push(scope + "." + name);
        return true;
      }
    } catch (_defineError) {}
    try {
      target[name] = value;
      if (typeof target[name] === "function") {
        compat.patched.push(scope + "." + name);
        return true;
      }
    } catch (_assignError) {}
    compat.failed.push(name + ":unpatchable");
    return false;
  };
  var collectPatchTargets = function(target) {
    var targets = [];
    var current = target;
    var depth = 0;
    while (current && depth < 6) {
      if ((typeof current === "object" || typeof current === "function") && targets.indexOf(current) === -1) {
        targets.push(current);
      }
      try {
        current = Object.getPrototypeOf(current);
      } catch (_prototypeError) {
        current = null;
      }
      depth += 1;
    }
    return targets;
  };
  var verifyRequiredMethods = function(target) {
    var result = {};
    for (var name in requiredMethods) {
      result[name] = Boolean(target && typeof target[name] === "function");
    }
    return result;
  };
  var hasAllRequiredMethods = function(target) {
    var verified = verifyRequiredMethods(target);
    for (var name in verified) {
      if (!verified[name]) {
        return false;
      }
    }
    return true;
  };
  var replacePerformanceObject = function() {
    var shim = {};
    if (perf && (typeof perf === "object" || typeof perf === "function")) {
      try {
        Object.setPrototypeOf(shim, perf);
      } catch (_setPrototypeError) {}
      for (var key in perf) {
        try {
          shim[key] = perf[key];
        } catch (_copyError) {}
      }
    }
    for (var methodName in requiredMethods) {
      shim[methodName] = createSafeMethod(methodName, requiredMethods[methodName]);
    }
    if (typeof shim.now !== "function") {
      shim.now = function() {
        return Date.now();
      };
    }
    if (typeof shim.timeOrigin !== "number") {
      shim.timeOrigin = Date.now();
    }
    try {
      Object.defineProperty(globalObject, "performance", {
        configurable: true,
        writable: true,
        value: shim,
      });
      compat.replacedPerformance = true;
      return Boolean(globalObject.performance);
    } catch (_replaceDefineError) {}
    try {
      globalObject.performance = shim;
      compat.replacedPerformance = true;
      return Boolean(globalObject.performance);
    } catch (_replaceAssignError) {}
    compat.failed.push("performance:replace-unpatchable");
    return false;
  };

  if (!perf || (typeof perf !== "object" && typeof perf !== "function")) {
    replacePerformanceObject();
  } else {
    var patchTargets = collectPatchTargets(perf);
    for (var name in requiredMethods) {
      var safeMethod = createSafeMethod(name, requiredMethods[name]);
      compat.wrapped.push(name);
      for (var index = 0; index < patchTargets.length; index += 1) {
        patchMethod(patchTargets[index], name, safeMethod, "performance[" + index + "]");
      }
    }
    if (!hasAllRequiredMethods(globalObject.performance)) {
      replacePerformanceObject();
    }
  }

  compat.verified = verifyRequiredMethods(globalObject.performance);

  globalObject.__txtPerformanceCompat = compat;
})();`;

export const metadata = {
  title: "TXT - Trader eXelle Terminal",
  description: "Human-first trading platform"
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const roleGroup = await getServerRoleGroup();
  return (
    <html lang="en">
      <body>
        <Script id="performance-compat-bootstrap" strategy="beforeInteractive">
          {PERFORMANCE_COMPAT_BOOTSTRAP}
        </Script>
        <UiModeController />
        <TxtGlobalNav roleGroup={roleGroup} />
        <GlobalPlatformWalkthrough roleGroup={roleGroup} />
        {children}
        <OpsChatbot />
      </body>
    </html>
  );
}
