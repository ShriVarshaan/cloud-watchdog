export function MainWindow() {
  return (
    <main className="main-window">
      <header className="main-header">
        <h1>Cloud Watchdog</h1>
      </header>
      <section className="empty-state" aria-labelledby="empty-title">
        <h2 id="empty-title">No AWS profile connected</h2>
        <p>
          Cloud Watchdog will use an AWS profile you have already set up with the AWS CLI. It never stores
          your keys.
        </p>
      </section>
    </main>
  )
}
