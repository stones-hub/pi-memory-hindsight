import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const EXPECTED_LICENSE_SHA256 = "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4";

function isDenyOnlyAllowScriptsPolicy(allowScripts: unknown): boolean {
  if (!allowScripts || typeof allowScripts !== "object" || Array.isArray(allowScripts)) return false;
  const entries = Object.entries(allowScripts as Record<string, unknown>);
  return entries.length > 0 && entries.every(([, allowed]) => allowed === false);
}

describe("git-install acceptance", () => {
  it(
    "ships Apache-2.0 LICENSE, deny-only allowScripts policy, and installs from loopback git daemon",
    () => {
      const rootPackage = JSON.parse(readFileSync("package.json", "utf8")) as {
        name: string;
        license: string;
        allowScripts?: Record<string, boolean>;
        files?: string[];
      };
      expect(rootPackage.name).toBe("pi-memory-hindsight");
      expect(rootPackage.license).toBe("Apache-2.0");
      expect(rootPackage.files).toContain("LICENSE");
      expect(isDenyOnlyAllowScriptsPolicy(rootPackage.allowScripts)).toBe(true);
      expect(rootPackage.allowScripts).toEqual({ "pi-memory-hindsight": false });

      execFileSync("npm", ["run", "acceptance:git-install"], {
        cwd: process.cwd(),
        stdio: "pipe",
        timeout: 150_000,
        encoding: "utf8",
      });
      const evidence = JSON.parse(readFileSync("/tmp/pi-memory-hindsight-git-install-acceptance.json", "utf8")) as {
        memoryCommandLoaded: boolean;
        extensionManifestEntry: string;
        gitDaemonStarted: boolean;
        piInstallCompleted: boolean;
        npmInstallCompleted: boolean;
        lowerPriorityUserNpmrcAllowScriptsPresent: boolean;
        packageDenyOnlyAllowScripts: boolean;
        packageLicenseField: string;
        licenseFileSha256: string;
        stagedLicenseMatchesRemote: boolean;
        packedLicenseIncluded: boolean;
        installSource: string;
        settingsPackageSource: string;
        installedCloneRelativePath: string;
        limitation: string;
      };
      expect(evidence.extensionManifestEntry).toBe("./src/index.ts");
      expect(evidence.packageLicenseField).toBe("Apache-2.0");
      expect(evidence.licenseFileSha256).toBe(EXPECTED_LICENSE_SHA256);
      expect(evidence.stagedLicenseMatchesRemote).toBe(true);
      expect(evidence.packedLicenseIncluded).toBe(true);
      expect(evidence.packageDenyOnlyAllowScripts).toBe(true);
      expect(evidence.lowerPriorityUserNpmrcAllowScriptsPresent).toBe(true);
      expect(evidence.npmInstallCompleted).toBe(true);
      expect(evidence.gitDaemonStarted).toBe(true);
      expect(evidence.piInstallCompleted).toBe(true);
      expect(evidence.memoryCommandLoaded).toBe(true);
      expect(evidence.installSource).toMatch(/^git:127\.0\.0\.1:\d+\/stones-hub\/pi-memory-hindsight\.git$/);
      expect(evidence.settingsPackageSource).toBe(evidence.installSource);
      expect(evidence.installedCloneRelativePath).toMatch(
        /^git\/127\.0\.0\.1:\d+\/stones-hub\/pi-memory-hindsight$/,
      );
      expect(evidence.limitation).toMatch(/loopback git daemon/i);
      expect(evidence.limitation).toMatch(/npm install --omit=dev/i);
      expect(evidence.limitation).toMatch(/lower-priority user/i);
      expect(evidence.limitation).not.toMatch(/skips npm install/i);
      expect(evidence.limitation).not.toMatch(/overrides it\.$/i);
    },
    150_000,
  );
});
