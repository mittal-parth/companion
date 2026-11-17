# Each user's computer is a microVM on a shared x86 host

Status: accepted. Supersedes the "one EC2 instance per user, stopped when idle" decision in the plan, and ADR 0004 for the VM image.

Stopping and starting an EC2 instance takes about 40 to 90 seconds to wake, and keeping one running per user costs too much. Products in this space wake a sleeping computer in a few seconds. We run many Firecracker microVMs per EC2 host, each under the jailer, and wake one by building a fresh microVM from the current image and attaching the user's EBS data volume, without a memory snapshot unless a spike shows disk-only wake is slower than about 5 seconds.

Nested virtualization on ordinary EC2 instances exists only on x86 (C8i, M8i, R8i), so the VM image moves from arm64 to x86. Arm64 would need bare-metal hosts at roughly $1,900 a month each. A managed microVM vendor would skip our host work but sit outside the AWS credits.

Users now share hosts, so the VM boundary is hypervisor isolation instead of a separate AWS account, a weaker wall that matches what Grok Bot's docs describe. OpenCode's own database lives on the data volume and is opened by whatever OpenCode version the new image ships, so an upgrade test is needed.

AWS Lambda MicroVMs, which run Firecracker for us, were tried in a spike and set aside (`docs/phase-4-5-lambda-spike.md`, scripts on the `spike/lambda-microvms` branch). A fresh start took 16 s at the median (against about 5 s here), and a resume after a few seconds of suspension took 3.9 s. A MicroVM lives at most 8 hours counting suspended time, its disk is lost when it ends, and one terminated while suspended runs no save, so a user's data would need a scheduled resume-and-save before every limit. The idle policy also ignores the relay's traffic, so the control plane would suspend and resume computers itself anyway. Cursor, DuskBot, Grok Bot and Muse all keep the user's data on a disk that outlives the compute, which is what the EBS volume does here.
