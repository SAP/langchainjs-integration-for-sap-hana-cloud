import * as fs from "fs";
import * as path from "path";

// Load package.json
const packageJsonPath = path.resolve(process.cwd(), "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));

// Function to check if a version is a prerelease
const isPrerelease = (version) => /-/.test(version); // any '-' in semver indicates prerelease

// Extract package version
const packageVersion = packageJson.version;

if (isPrerelease(packageVersion)) {
  throw new Error(
    `The package version (${packageVersion}) is a prerelease version. Please update it to a stable version before releasing.`
  );
}

// Merge dependencies and devDependencies
const allDeps = {
  ...(packageJson.dependencies || {}),
  ...(packageJson.devDependencies || {}),
};

// Find all prerelease dependencies
const prereleaseDeps = Object.entries(allDeps)
  .filter(([name, version]) => isPrerelease(version))
  .map(([name, version]) => ({ name, version }));

if (prereleaseDeps.length > 0) {
  throw new Error(
    `Found prerelease dependencies:\n${prereleaseDeps
      .map((dep) => `- ${dep.name}: ${dep.version}`)
      .join("\n")}.\nPlease update them to stable versions before releasing.`
  );
}
