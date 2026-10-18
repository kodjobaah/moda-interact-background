export async function startHumanCommandDispatcher(): Promise<() => Promise<void>> {
  const { HumanCommandDispatcherService } = await import("./human-command-dispatcher.service.js");
  const dispatcher = new HumanCommandDispatcherService();
  dispatcher.start();
  return () => dispatcher.close();
}