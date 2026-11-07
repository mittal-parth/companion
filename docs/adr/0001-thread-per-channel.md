# One thread per channel conversation

A bot can be reached from the web app and, later, from Slack or Discord. Each of those conversations is its own thread, and the threads share that bot's files and memory. One shared transcript would mix different audiences into a single log, and each channel adapter would have to pull its own conversation back out. The thread stays free of channel-specific fields. A channel is a separate way of delivering into a thread. Replacing the engine's session does not create a new thread.
