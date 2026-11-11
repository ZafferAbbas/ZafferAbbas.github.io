import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../services/api.dart';
import '../services/secure_key.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final _api = AttendanceApi(Supabase.instance.client);

  DeviceState? _device;
  List<Site> _sites = [];
  List<AttendanceRecord> _history = [];
  String? _loadError;
  bool _busy = false;
  String? _busySiteId;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loadError = null);
    try {
      final device = await _api.deviceState();
      final sites = device == DeviceState.active ? await _api.sites() : <Site>[];
      final history = await _api.history();
      if (!mounted) return;
      setState(() {
        _device = device;
        _sites = sites;
        _history = history;
      });
    } catch (e) {
      if (mounted) setState(() => _loadError = 'Couldn\'t load. Pull down to retry.');
    }
  }

  void _toast(String msg) =>
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));

  Future<void> _register() async {
    setState(() => _busy = true);
    try {
      final state = await _api.registerDevice();
      if (!mounted) return;
      _toast(state == DeviceState.active
          ? 'This phone is registered. You can check in now.'
          : 'Request sent. An admin needs to approve this phone.');
      await _load();
    } on SecureKeyException catch (e) {
      if (!e.cancelled) _toast(e.message);
    } on AppException catch (e) {
      _toast(e.message);
    } catch (_) {
      _toast('Registration failed. Please try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _checkIn(Site site) async {
    setState(() => _busySiteId = site.id);
    try {
      final res = await _api.checkIn(site);
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (c) => AlertDialog(
          icon: const Icon(Icons.check_circle, color: Colors.green, size: 48),
          title: const Text('Checked in'),
          content: Text('${res.siteName}\n${TimeOfDay.now().format(c)}'),
          actions: [TextButton(onPressed: () => Navigator.pop(c), child: const Text('OK'))],
        ),
      );
      await _load();
    } on SecureKeyException catch (e) {
      if (e.code == 'KEY_INVALIDATED' || e.code == 'NO_KEY') {
        await _load(); // shows the "register again" card
      }
      if (!e.cancelled) _toast(e.message);
    } on AppException catch (e) {
      _toast(e.message);
    } catch (_) {
      _toast('Check-in failed. Please try again.');
    } finally {
      if (mounted) setState(() => _busySiteId = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final user = Supabase.instance.client.auth.currentUser;
    final name = user?.userMetadata?['full_name'] as String? ?? user?.email ?? '';

    return Scaffold(
      appBar: AppBar(
        title: const Text('Attendance'),
        actions: [
          IconButton(
            tooltip: 'Sign out',
            icon: const Icon(Icons.logout),
            onPressed: () => Supabase.instance.client.auth.signOut(),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Text('Hi, $name', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 16),
            if (_loadError != null)
              _InfoCard(icon: Icons.cloud_off, title: _loadError!)
            else if (_device == null)
              const Padding(
                padding: EdgeInsets.all(32),
                child: Center(child: CircularProgressIndicator()),
              )
            else
              ..._deviceSection(),
            const SizedBox(height: 24),
            if (_history.isNotEmpty) ...[
              Text('Recent check-ins', style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 8),
              for (final r in _history)
                ListTile(
                  dense: true,
                  leading: const Icon(Icons.check),
                  title: Text(r.siteName),
                  subtitle: Text(_formatDate(context, r.checkedInAt)),
                ),
            ],
          ],
        ),
      ),
    );
  }

  List<Widget> _deviceSection() {
    switch (_device!) {
      case DeviceState.needsRegistration:
        return [
          _InfoCard(
            icon: Icons.phonelink_lock,
            title: 'Register this phone',
            body: 'Check-ins only work from your own registered phone. '
                'You\'ll confirm with your fingerprint or Face ID.\n\n'
                'If you\'ve used another phone before, an admin will need to approve this one.',
            action: FilledButton.icon(
              onPressed: _busy ? null : _register,
              icon: const Icon(Icons.fingerprint),
              label: Text(_busy ? 'Registering…' : 'Register this phone'),
            ),
          ),
        ];
      case DeviceState.pending:
        return [
          const _InfoCard(
            icon: Icons.hourglass_top,
            title: 'Waiting for approval',
            body: 'An admin needs to approve this phone before you can check in. '
                'Pull down to refresh.',
          ),
        ];
      case DeviceState.active:
        if (_sites.isEmpty) {
          return [const _InfoCard(icon: Icons.location_off, title: 'No locations set up yet')];
        }
        return [
          Text('Check in at', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          for (final site in _sites)
            Card(
              child: ListTile(
                leading: const Icon(Icons.place),
                title: Text(site.name),
                subtitle: Text('Within ${site.radiusM} m'),
                trailing: _busySiteId == site.id
                    ? const SizedBox.square(
                        dimension: 24, child: CircularProgressIndicator(strokeWidth: 2))
                    : FilledButton(
                        onPressed: _busySiteId == null ? () => _checkIn(site) : null,
                        child: const Text('Check in'),
                      ),
              ),
            ),
        ];
    }
  }

  String _formatDate(BuildContext context, DateTime d) {
    final l = MaterialLocalizations.of(context);
    return '${l.formatMediumDate(d)}, ${l.formatTimeOfDay(TimeOfDay.fromDateTime(d))}';
  }
}

class _InfoCard extends StatelessWidget {
  const _InfoCard({required this.icon, required this.title, this.body, this.action});
  final IconData icon;
  final String title;
  final String? body;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(children: [
              Icon(icon, color: Theme.of(context).colorScheme.primary),
              const SizedBox(width: 12),
              Expanded(child: Text(title, style: Theme.of(context).textTheme.titleMedium)),
            ]),
            if (body != null) ...[const SizedBox(height: 12), Text(body!)],
            if (action != null) ...[const SizedBox(height: 16), action!],
          ],
        ),
      ),
    );
  }
}
