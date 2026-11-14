# User VMs run on Graviton (arm64)

**Decision:** The image and every tool in it target Linux arm64 (Graviton). No tool we ship needs x86, so the fallback to x86 in the plan is not taken.

Checked on 2026-11-14 against the versions we pin or install. Each one publishes a Linux arm64 build:

| Tool                                                       | arm64 build                                                                      |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Node 24                                                    | Official `linux-arm64` tarball                                                   |
| OpenCode 2.2.6 (the version our fixtures were recorded on) | `opencode-linux-arm64.tar.gz` on the GitHub release, with `SHA256SUMS`           |
| agent-browser 0.42.0                                       | `bin/agent-browser-linux-arm64` in the npm package                               |
| agent-desktop 1.2.0                                        | `bin/agent-desktop-linux-arm64` and its clipboard owner in the npm package       |
| Google Chrome                                              | `google-chrome-stable_current_arm64.deb` (also Chrome for Testing `linux-arm64`) |
| Xvfb, Openbox, D-Bus, AT-SPI                               | Ubuntu 24.04 arm64 packages                                                      |
| Mousepad, Galculator                                       | Ubuntu 24.04 arm64 packages                                                      |

The daemon starts Xvfb, Openbox, D-Bus, the accessibility bus and Chrome itself, when something first asks for the screen. The image only has to contain those programs. It needs no service manager for them.

OpenCode comes from the GitHub release, not npm. The `opencode-ai` package on npm is a different, older line (1.19.5), so it is not used. The image downloads the tarball and verifies its checksum.

Re-check this table when a tool is added or a version is bumped. The image build fails if a binary is not arm64.
