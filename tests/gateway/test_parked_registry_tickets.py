import pytest

from gateway.runtime_bootstrap import TicketStore
from gateway.run_runtime import parked_registry_profile_allowed


def test_only_registered_parked_unserved_directories_are_eligible(tmp_path):
    profiles = tmp_path / 'profiles'
    parked = profiles / 'parked'
    parked.mkdir(parents=True)
    (parked / 'gateway.parked').touch()
    active = profiles / 'active'
    active.mkdir()
    elsewhere = tmp_path / 'elsewhere'
    elsewhere.mkdir()
    (elsewhere / 'gateway.parked').touch()
    (profiles / 'link').symlink_to(elsewhere, target_is_directory=True)
    class Registry:
        def for_home(self, home):
            return object() if str(home) == str(parked) and self.running else None
        running = False
    registry = Registry()
    assert parked_registry_profile_allowed(str(parked), tmp_path, registry)
    assert not parked_registry_profile_allowed(str(active), tmp_path, registry)
    assert not parked_registry_profile_allowed(str(elsewhere), tmp_path, registry)
    assert not parked_registry_profile_allowed(str(profiles / 'link'), tmp_path, registry)
    assert not parked_registry_profile_allowed(str(profiles / 'missing'), tmp_path, registry)
    registry.running = True
    assert not parked_registry_profile_allowed(str(parked), tmp_path, registry)


def test_parked_registry_ticket_is_narrow_and_single_use():
    store = TicketStore('owner', frozenset({'active'}), registry_profile_allowed=lambda p: p == 'parked')
    for purpose in ('interactive', 'native-http', 'native-profile-create', 'exposure'):
        with pytest.raises(PermissionError):
            store.mint(profile_id='parked', subject='uid:1', purpose=purpose)
    with pytest.raises(PermissionError):
        store.mint(profile_id='other', subject='uid:1', purpose='native-profile-registry')
    ticket = store.mint(profile_id='parked', subject='uid:1', purpose='native-profile-registry')
    with pytest.raises(PermissionError):
        store.redeem(ticket, profile_id='other', purpose='native-profile-registry')
    with pytest.raises(PermissionError):
        store.redeem(ticket, profile_id=None, purpose='native-http')
    grant = store.redeem(ticket, profile_id=None, purpose='native-profile-registry')
    assert grant['profile_id'] == 'parked'
    assert grant['capabilities'] == frozenset({'profiles:registry'})
    with pytest.raises(PermissionError):
        store.redeem(ticket, profile_id=None, purpose='native-profile-registry')


def test_parked_registry_authorization_rechecked_at_redemption():
    allowed = {'parked'}
    store = TicketStore('owner', frozenset({'active'}), registry_profile_allowed=lambda p: p in allowed)
    ticket = store.mint(profile_id='parked', subject='uid:1', purpose='native-profile-registry')
    allowed.clear()
    with pytest.raises(PermissionError):
        store.redeem(ticket, profile_id='parked', purpose='native-profile-registry')
    with pytest.raises(PermissionError):
        store.redeem(ticket, profile_id=None, purpose='native-profile-registry')
